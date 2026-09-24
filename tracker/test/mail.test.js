/* Checks the built-in SMTP client against a tiny fake mail server (plain, AUTH PLAIN). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { Mailer } = require("../lib/mail");

function fakeSmtp() {
  const received = { auth: null, from: null, rcpt: [], data: "" };
  const server = net.createServer((sock) => {
    let inData = false, buf = "";
    sock.write("220 fake.local ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 OK queued\r\n"); }
          else received.data += line.replace(/^\.\./, ".") + "\n";
          continue;
        }
        const cmd = line.split(" ")[0].toUpperCase();
        if (cmd === "EHLO") sock.write("250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd === "AUTH") { received.auth = Buffer.from(line.split(" ")[2], "base64").toString(); sock.write("235 ok\r\n"); }
        else if (cmd === "MAIL") { received.from = line; sock.write("250 ok\r\n"); }
        else if (cmd === "RCPT") { received.rcpt.push(line); sock.write("250 ok\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 what\r\n");
      }
    });
  });
  return { server, received };
}

test("SMTP client sends a multipart message with authentication", async () => {
  const { server, received } = fakeSmtp();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const mailer = new Mailer({ host: "127.0.0.1", port, secure: false, requireTls: false, user: "tracker", pass: "s3cret", from: "Tracker <tracker@maxkirwan.com.au>", outboxFile: "" }, () => {});
  mailer.send({ to: ["parts@maxkirwan.com.au", "Steve <steves@maxkirwan.com.au>"], subject: "Parts quote required – Jane Citizen", text: "Line one.\n.starts with a dot", html: "<p>Hi</p>" });
  for (let i = 0; i < 50 && !mailer.sent.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].status, "sent");
  assert.equal(received.auth, "\0tracker\0s3cret");
  assert.equal(received.from, "MAIL FROM:<tracker@maxkirwan.com.au>");
  assert.deepEqual(received.rcpt, ["RCPT TO:<parts@maxkirwan.com.au>", "RCPT TO:<steves@maxkirwan.com.au>"]);
  assert.match(received.data, /Subject: =\?UTF-8\?B\?/);           // non-ASCII subject is encoded
  assert.match(received.data, /Content-Type: multipart\/alternative/);
  assert.match(received.data, /\n\.starts with a dot\n/);            // dot-stuffing undone by server
  server.close();
});

test("refuses to send in the clear when TLS is required and not offered", async () => {
  const { server } = fakeSmtp();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const mailer = new Mailer({ host: "127.0.0.1", port: server.address().port, secure: false, requireTls: true, from: "t@x.au", outboxFile: "" }, () => {});
  mailer.send({ to: "a@x.au", subject: "x", text: "x" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mailer.sent.length, 0);
  assert.equal(mailer.queue.length, 0);           // waiting on its retry timer, not sent
  server.close();
});

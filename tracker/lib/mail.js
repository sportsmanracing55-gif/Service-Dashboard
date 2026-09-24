/* =====================================================================
   mail.js – outgoing email with no third-party packages.

   A small SMTP client (STARTTLS on 587, implicit TLS on 465, AUTH PLAIN /
   LOGIN) talks to the dealership's own mail server. Messages are queued
   and retried. When SMTP is not configured the message is written to
   data/outbox.log instead so the tracker still works during setup.
   ===================================================================== */
"use strict";
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const os = require("os");

class SmtpClient {
  constructor(cfg) { this.cfg = cfg; this.socket = null; this.buffer = ""; this.waiters = []; }

  connect() {
    const cfg = this.cfg;
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
      this.socket = cfg.secure ? tls.connect(opts) : net.connect(opts);
      this.socket.setTimeout(30000, () => this._fail(new Error("SMTP timeout")));
      this.socket.once("error", onError);
      this.socket.on("data", (d) => this._onData(d));
      this.socket.on("close", () => this._fail(new Error("SMTP connection closed")));
      this.socket.once(cfg.secure ? "secureConnect" : "connect", () => {
        this.socket.removeListener("error", onError);
        this.socket.on("error", (e) => this._fail(e));
        resolve();
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const w = this.waiters[0];
      if (!w) continue;
      w.lines.push(line);
      if (/^\d{3} /.test(line)) { // final line of a (possibly multi-line) reply
        this.waiters.shift();
        const code = parseInt(line.slice(0, 3), 10);
        w.resolve({ code, lines: w.lines });
      }
    }
  }
  _fail(err) {
    const ws = this.waiters; this.waiters = [];
    ws.forEach((w) => w.reject(err));
  }

  read() { return new Promise((resolve, reject) => this.waiters.push({ lines: [], resolve, reject })); }
  async cmd(line, okCodes) {
    const p = this.read();
    this.socket.write(line + "\r\n");
    const r = await p;
    if (okCodes && !okCodes.includes(r.code)) throw new Error("SMTP " + line.split(" ")[0] + " failed: " + r.lines.join(" | "));
    return r;
  }

  async startTls() {
    await this.cmd("STARTTLS", [220]);
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: this.cfg.host }, () => resolve());
      s.once("error", reject);
      s.on("data", (d) => this._onData(d));
      s.on("close", () => this._fail(new Error("SMTP connection closed")));
      this.socket = s;
    });
  }

  async send(msg) {
    try { await this._send(msg); }
    catch (err) { try { this.socket && this.socket.destroy(); } catch (e) { /* ignore */ } throw err; }
  }

  async _send(msg) {
    const cfg = this.cfg;
    await this.connect();
    const greet = await this.read();
    if (greet.code !== 220) throw new Error("SMTP greeting failed: " + greet.lines.join(" "));
    const helo = () => this.cmd("EHLO " + (cfg.name || os.hostname() || "localhost"), [250]);
    let ehlo = await helo();
    if (!cfg.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await this.startTls();
      ehlo = await helo();
    } else if (!cfg.secure && cfg.requireTls !== false) {
      throw new Error("SMTP server did not offer STARTTLS. Set SMTP_REQUIRE_TLS=false to send unencrypted (not recommended).");
    }
    if (cfg.user) {
      const authLine = ehlo.lines.find((l) => /^250[ -]AUTH/i.test(l)) || "";
      if (/PLAIN/i.test(authLine) || !/LOGIN/i.test(authLine)) {
        const cred = Buffer.from("\0" + cfg.user + "\0" + cfg.pass).toString("base64");
        await this.cmd("AUTH PLAIN " + cred, [235]);
      } else {
        await this.cmd("AUTH LOGIN", [334]);
        await this.cmd(Buffer.from(cfg.user).toString("base64"), [334]);
        await this.cmd(Buffer.from(cfg.pass).toString("base64"), [235]);
      }
    }
    await this.cmd("MAIL FROM:<" + msg.fromAddress + ">", [250]);
    for (const rcpt of msg.to) await this.cmd("RCPT TO:<" + rcpt + ">", [250, 251]);
    await this.cmd("DATA", [354]);
    const data = msg.raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await this.cmd(data + "\r\n.", [250]);
    try { await this.cmd("QUIT", [221]); } catch (e) { /* server may just close */ }
    try { this.socket.end(); } catch (e) { /* ignore */ }
  }
}

function addressOnly(s) { const m = /<([^>]+)>/.exec(s || ""); return (m ? m[1] : String(s || "")).trim(); }
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function buildRaw(msg) {
  const boundary = "----=_pm_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const headers = [
    "From: " + msg.from,
    "To: " + msg.to.join(", "),
    "Subject: " + encodeHeader(msg.subject),
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + Date.now().toString(36) + "." + Math.random().toString(36).slice(2) + "@" + (msg.domain || "tracker.local") + ">",
    "MIME-Version: 1.0",
    "X-Mailer: Preston Mazda Enquiry Tracker"
  ];
  if (msg.html) {
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    return headers.join("\r\n") + "\r\n\r\n" +
      "--" + boundary + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + msg.text + "\r\n" +
      "--" + boundary + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + msg.html + "\r\n" +
      "--" + boundary + "--\r\n";
  }
  headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
  return headers.join("\r\n") + "\r\n\r\n" + msg.text + "\r\n";
}

class Mailer {
  constructor(cfg, log) {
    this.cfg = cfg;           // { host, port, secure, user, pass, from, requireTls, name, outboxFile }
    this.log = log || console.log;
    this.queue = [];
    this.busy = false;
    this.sent = [];           // last few results (for the admin "mail status" panel)
  }
  get configured() { return !!(this.cfg.host && this.cfg.from); }

  /** Queue a message. to: string | string[]. Returns immediately. */
  send(msg) {
    const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(addressOnly).filter(Boolean);
    if (!to.length) return;
    const full = {
      from: this.cfg.from || "tracker@localhost",
      fromAddress: addressOnly(this.cfg.from || "tracker@localhost"),
      to, subject: msg.subject, text: msg.text || "", html: msg.html || "",
      domain: addressOnly(this.cfg.from || "tracker@localhost").split("@")[1],
      attempts: 0, queuedAt: new Date().toISOString()
    };
    full.raw = buildRaw(full);
    this.queue.push(full);
    this._drain();
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const m = this.queue.shift();
      try {
        if (!this.configured) {
          this._outbox(m);
        } else {
          await new SmtpClient(this.cfg).send(m);
        }
        this._record(m, "sent");
      } catch (err) {
        m.attempts++;
        this.log("[mail] failed to send '" + m.subject + "' to " + m.to.join(",") + ": " + err.message);
        if (m.attempts < 3) {
          const delay = 5000 * Math.pow(3, m.attempts - 1);
          setTimeout(() => { this.queue.push(m); this._drain(); }, delay).unref();
        } else {
          this._record(m, "failed: " + err.message);
          this._outbox(m, "FAILED: " + err.message);
        }
      }
    }
    this.busy = false;
  }

  _outbox(m, note) {
    if (!this.cfg.outboxFile) return;
    const entry = "==== " + new Date().toISOString() + (note ? " " + note : " (SMTP not configured – logged only)") + "\n" +
      "To: " + m.to.join(", ") + "\nSubject: " + m.subject + "\n\n" + m.text + "\n\n";
    fs.mkdirSync(path.dirname(this.cfg.outboxFile), { recursive: true });
    fs.appendFileSync(this.cfg.outboxFile, entry);
    if (!this.configured) this.log("[mail] SMTP not configured; wrote '" + m.subject + "' for " + m.to.join(",") + " to outbox.log");
  }
  _record(m, status) {
    this.sent.unshift({ to: m.to, subject: m.subject, at: new Date().toISOString(), status });
    if (this.sent.length > 50) this.sent.length = 50;
  }
}

module.exports = { Mailer, SmtpClient, buildRaw };

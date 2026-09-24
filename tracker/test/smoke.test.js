/* End-to-end smoke test: boots the server on a random port with a temporary
   data folder and walks through registration, approval, login, enquiries,
   allocation alerts, notes, PDF attachments, notifications and password reset. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-tracker-"));
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.DATA_KEY = "test-passphrase";
process.env.SMTP_HOST = "";           // no SMTP → mail goes to outbox.log
process.env.APP_URL = "http://tracker.test";

const srv = require("../server.js");
let base = "";
const jars = {};

function client(name) {
  jars[name] = jars[name] || "";
  return async function (method, p, body, opts) {
    const headers = { "X-Requested-With": "PrestonMazdaTracker" };
    if (jars[name]) headers.Cookie = jars[name];
    let payload;
    if (body !== undefined) {
      if (opts && opts.raw) { payload = body; headers["Content-Type"] = "application/pdf"; }
      else { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
    const sc = res.headers.get("set-cookie");
    if (sc) jars[name] = sc.split(";")[0];
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  };
}
const outbox = () => { const f = path.join(dataDir, "outbox.log"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test.before(async () => {
  const server = srv.start();
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { srv.store.flush(); process.exit(0); });

const steve = client("steve"), sam = client("sam"), pat = client("pat"), guest = client("guest");

test("static pages and shared brand assets are served", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /Preston Mazda/);
  assert.doesNotMatch(text, /<title>Mazda Service Dashboard/);
  assert.equal((await fetch(base + "/css/styles.css")).status, 200);
  assert.equal((await fetch(base + "/css/tracker.css")).status, 200);
  assert.equal((await fetch(base + "/assets/preston-mazda-logo.svg")).status, 200);
  assert.equal((await fetch(base + "/assets/../server.js")).status, 404);
  assert.equal((await fetch(base + "/..%2Fserver.js")).status, 404);
  const csp = html.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
});

test("registration is limited to work email addresses and needs approval", async () => {
  let r = await guest("POST", "/api/auth/register", { name: "Outsider", email: "x@gmail.com", password: "Secret12345", department: "service" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /work email/);
  r = await guest("POST", "/api/auth/register", { name: "Weak", email: "weak@maxkirwan.com.au", password: "short", department: "service" });
  assert.equal(r.status, 400);

  // The approver registers first and is auto-approved as an administrator.
  r = await steve("POST", "/api/auth/register", { name: "Steve S", email: "SteveS@maxkirwan.com.au", password: "Approver2026x", department: "management" });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "active");
  assert.equal(r.data.user.role, "admin");

  // A service advisor registers and must wait.
  r = await sam("POST", "/api/auth/register", { name: "Sam Carter", email: "sam@maxkirwan.com.au", password: "Advisor2026x", department: "service" });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "pending");
  r = await sam("POST", "/api/auth/login", { email: "sam@maxkirwan.com.au", password: "Advisor2026x" });
  assert.equal(r.status, 403);
  assert.equal(r.data.status, "pending");
  await wait(80);
  assert.match(outbox(), /To: steves@maxkirwan.com.au[\s\S]*Account approval needed – Sam Carter/);
});

test("the approver sees the pending account, approves it, and the advisor can sign in", async () => {
  let r = await steve("GET", "/api/users");
  const pending = r.data.users.find((u) => u.email === "sam@maxkirwan.com.au");
  assert.equal(pending.status, "pending");
  r = await steve("PATCH", "/api/users/" + pending.id, { status: "active" });
  assert.equal(r.status, 200);
  r = await sam("POST", "/api/auth/login", { email: "sam@maxkirwan.com.au", password: "Advisor2026x" });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.department, "service");
  await wait(80);
  assert.match(outbox(), /Account approved/);
  // Non-admins cannot manage users.
  r = await sam("POST", "/api/users", { name: "X", email: "x@maxkirwan.com.au" });
  assert.equal(r.status, 403);
});

test("an administrator can add a parts user directly, who sets a password from the invite link", async () => {
  let r = await steve("POST", "/api/users", { name: "Pat Parts", email: "pat@maxkirwan.com.au", department: "parts" });
  assert.equal(r.status, 200);
  await wait(80);
  const m = /reset\?token=([A-Za-z0-9_-]+)/.exec(outbox().split("Your enquiry tracker account").pop());
  assert.ok(m, "invite link should be in the email");
  r = await pat("POST", "/api/auth/reset", { token: m[1], password: "PartsPerson99" });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.department, "parts");
  r = await pat("GET", "/api/auth/me");
  assert.equal(r.status, 200);
});

test("logging an enquiry with a parts quote required emails parts@ and pops up for parts staff", async () => {
  const notifications = [];
  const es = await fetch(base + "/api/events", { headers: { Cookie: jars.pat } });
  assert.equal(es.status, 200);
  const reader = es.body.getReader();
  (async () => { const dec = new TextDecoder(); let buf = ""; for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (\w+)/.exec(chunk); const d = /data: (.*)/.exec(chunk); if (ev && d) notifications.push({ event: ev[1], data: JSON.parse(d[1]) }); } } })().catch(() => {});
  await wait(50);

  let r = await sam("POST", "/api/enquiries", {
    customer: { name: "Jane Citizen", registration: "abc123", phone: "0400 000 000", email: "jane@example.com", preferred: "text" },
    enquiry: "Price on a set of front brake pads and rotors for a CX-5.",
    advisor: { userId: (await sam("GET", "/api/auth/me")).data.user.id, contactRequired: false, done: false },
    parts: { userId: null, quoteRequired: true, done: false }
  });
  assert.equal(r.status, 200);
  const e = r.data.enquiry;
  assert.equal(e.ref, "E-0001");
  assert.equal(e.customer.registration, "ABC123");
  assert.equal(e.customer.preferred, "text");
  await wait(120);
  assert.match(outbox(), /To: parts@maxkirwan.com.au\nSubject: \[Preston Mazda\] Parts quote required – Jane Citizen \(ABC123\)/);
  const popup = notifications.find((n) => n.event === "notification");
  assert.ok(popup, "parts staff should get a live pop-up notification");
  assert.match(popup.data.title, /Parts quote required/);
  assert.ok(notifications.some((n) => n.event === "enquiries" && n.data.action === "created"));
  reader.cancel();
  global.__enquiryId = e.id;
});

test("flagging that an advisor must contact the customer emails advisors@; allocation emails the advisor", async () => {
  const id = global.__enquiryId;
  const pat_id = (await pat("GET", "/api/auth/me")).data.user.id;
  let r = await pat("PATCH", "/api/enquiries/" + id, { advisor: { contactRequired: true }, parts: { userId: pat_id } });
  assert.equal(r.status, 200);
  await wait(120);
  assert.match(outbox(), /To: advisors@maxkirwan.com.au\nSubject: \[Preston Mazda\] Customer contact required – Jane Citizen/);
  // The allocated advisor (Sam) also gets an in-app notification for the contact flag.
  r = await sam("GET", "/api/notifications");
  assert.ok(r.data.notifications.some((n) => /Customer contact required/.test(n.title)));
  // Parts marks their quote done → Sam is emailed and notified.
  r = await pat("PATCH", "/api/enquiries/" + id, { parts: { done: true } });
  assert.equal(r.data.enquiry.parts.done, true);
  assert.equal(r.data.enquiry.parts.doneByName, "Pat Parts");
  await wait(120);
  assert.match(outbox(), /To: sam@maxkirwan.com.au\nSubject: \[Preston Mazda\] Parts quote ready – E-0001/);
  // A parts user cannot be allocated as a service advisor.
  r = await steve("PATCH", "/api/enquiries/" + id, { advisor: { userId: pat_id } });
  assert.equal(r.status, 400);
  // Reallocating the advisor to Sam from another user emails Sam.
  r = await steve("PATCH", "/api/enquiries/" + id, { advisor: { userId: null } });
  r = await steve("PATCH", "/api/enquiries/" + id, { advisor: { userId: (await sam("GET", "/api/auth/me")).data.user.id } });
  await wait(120);
  assert.match(outbox(), /To: sam@maxkirwan.com.au\nSubject: \[Preston Mazda\] Enquiry E-0001 allocated to you/);
});

test("notes record who spoke to the customer; PDFs can be attached, viewed and removed", async () => {
  const id = global.__enquiryId;
  let r = await sam("POST", "/api/enquiries/" + id + "/notes", { text: "Customer called, wants the quote by Friday.", spokeWith: "Sam Carter" });
  assert.equal(r.status, 200);
  assert.equal(r.data.note.spokeWith, "Sam Carter");
  assert.equal(r.data.note.authorName, "Sam Carter");
  r = await sam("POST", "/api/enquiries/" + id + "/notes", { text: "" });
  assert.equal(r.status, 400);

  r = await pat("POST", "/api/enquiries/" + id + "/attachments?filename=brake%20quote.pdf", PDF, { raw: true });
  assert.equal(r.status, 200);
  const att = r.data.attachment;
  assert.equal(att.name, "brake quote.pdf");
  r = await pat("POST", "/api/enquiries/" + id + "/attachments?filename=notes.txt", Buffer.from("hi"), { raw: true });
  assert.equal(r.status, 400);
  r = await pat("POST", "/api/enquiries/" + id + "/attachments?filename=fake.pdf", Buffer.from("not a pdf"), { raw: true });
  assert.equal(r.status, 400);

  // Stored file is encrypted at rest (DATA_KEY set) – never plain %PDF on disk.
  const stored = fs.readFileSync(srv.store.attachmentPath(id, att.id));
  assert.equal(stored.subarray(0, 6).toString(), "PMENC1");
  const dl = await fetch(base + "/api/enquiries/" + id + "/attachments/" + att.id, { headers: { Cookie: jars.sam } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), PDF.toString());
  // Not available without a session.
  assert.equal((await fetch(base + "/api/enquiries/" + id + "/attachments/" + att.id)).status, 401);
  // Only the uploader or an admin can remove.
  r = await sam("DELETE", "/api/enquiries/" + id + "/attachments/" + att.id);
  assert.equal(r.status, 403);
  r = await steve("DELETE", "/api/enquiries/" + id + "/attachments/" + att.id);
  assert.equal(r.status, 200);
  assert.equal(r.data.enquiry.attachments.length, 0);
});

test("the list is live-filtered by status and the database is encrypted on disk", async () => {
  const id = global.__enquiryId;
  let r = await sam("PATCH", "/api/enquiries/" + id, { status: "closed" });
  assert.equal(r.data.enquiry.status, "closed");
  r = await sam("GET", "/api/enquiries?status=open");
  assert.equal(r.data.enquiries.length, 0);
  r = await sam("GET", "/api/enquiries?status=all");
  assert.equal(r.data.enquiries.length, 1);
  srv.store.flush();
  const raw = fs.readFileSync(path.join(dataDir, "db.json"));
  assert.equal(raw.subarray(0, 6).toString(), "PMENC1");
  assert.doesNotMatch(raw.toString("latin1"), /Jane Citizen/);
});

test("forgotten passwords are reset by an emailed link; wrong logins are rate limited", async () => {
  let r = await guest("POST", "/api/auth/forgot", { email: "sam@maxkirwan.com.au" });
  assert.equal(r.status, 200);
  await wait(80);
  const m = /reset\?token=([A-Za-z0-9_-]+)/.exec(outbox().split("Password reset").pop());
  assert.ok(m);
  r = await guest("POST", "/api/auth/reset", { token: "bogus", password: "Whatever12345" });
  assert.equal(r.status, 400);
  r = await guest("POST", "/api/auth/reset", { token: m[1], password: "NewAdvisor2027" });
  assert.equal(r.status, 200);
  // Old sessions are revoked; the new password works; the link is single use.
  r = await sam("GET", "/api/auth/me");
  assert.equal(r.status, 401);
  r = await guest("POST", "/api/auth/reset", { token: m[1], password: "NewAdvisor2027" });
  assert.equal(r.status, 400);
  r = await sam("POST", "/api/auth/login", { email: "sam@maxkirwan.com.au", password: "NewAdvisor2027" });
  assert.equal(r.status, 200);

  const bad = client("bad");
  let last;
  for (let i = 0; i < 12; i++) last = await bad("POST", "/api/auth/login", { email: "steves@maxkirwan.com.au", password: "wrong" + i });
  assert.equal(last.status, 429);
  // Mutating requests without the custom header are rejected (CSRF guard).
  const res = await fetch(base + "/api/enquiries", { method: "POST", headers: { Cookie: jars.sam, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

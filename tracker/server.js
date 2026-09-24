#!/usr/bin/env node
/* =====================================================================
   Preston Mazda – Customer Enquiry Tracker server

   Run with:  node tracker/server.js
   Everything (accounts, enquiries, notes, PDF quotes) is kept on this
   machine under tracker/data. No cloud services are used; the only
   outbound connection is to your own SMTP mail server for alerts.
   ===================================================================== */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Store } = require("./lib/store");
const auth = require("./lib/auth");
const { Mailer } = require("./lib/mail");
const { App, HttpError, json, readBody, readJson, cookie } = require("./lib/http");

// ---- configuration ---------------------------------------------------------
function loadConfig() {
  const file = path.join(__dirname, "config.json");
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try { fileCfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("config.json is not valid JSON: " + e.message); process.exit(1); }
  }
  const env = process.env;
  const pick = (key, def) => (env[key] != null && env[key] !== "" ? env[key] : (fileCfg[key] != null ? fileCfg[key] : def));
  const bool = (v) => v === true || String(v).toLowerCase() === "true" || String(v) === "1";
  const cfg = {
    PORT: parseInt(pick("PORT", 8080), 10),
    HOST: pick("HOST", "0.0.0.0"),
    APP_URL: String(pick("APP_URL", "")).replace(/\/+$/, ""),
    DATA_DIR: path.resolve(__dirname, String(pick("DATA_DIR", "data"))),
    DATA_KEY: String(pick("DATA_KEY", "")),
    DEALER_NAME: pick("DEALER_NAME", "Preston Mazda"),
    APPROVER_EMAIL: String(pick("APPROVER_EMAIL", "steves@maxkirwan.com.au")).toLowerCase(),
    ADMIN_EMAILS: String(pick("ADMIN_EMAILS", "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    PARTS_EMAIL: pick("PARTS_EMAIL", "parts@maxkirwan.com.au"),
    ADVISORS_EMAIL: pick("ADVISORS_EMAIL", "advisors@maxkirwan.com.au"),
    ALLOWED_EMAIL_DOMAINS: String(pick("ALLOWED_EMAIL_DOMAINS", "maxkirwan.com.au")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    SESSION_HOURS: parseFloat(pick("SESSION_HOURS", 12)),
    MAX_UPLOAD_MB: parseFloat(pick("MAX_UPLOAD_MB", 15)),
    SMTP_HOST: pick("SMTP_HOST", ""),
    SMTP_PORT: parseInt(pick("SMTP_PORT", 587), 10),
    SMTP_SECURE: bool(pick("SMTP_SECURE", false)),
    SMTP_REQUIRE_TLS: bool(pick("SMTP_REQUIRE_TLS", true)),
    SMTP_USER: pick("SMTP_USER", ""),
    SMTP_PASS: pick("SMTP_PASS", ""),
    MAIL_FROM: pick("MAIL_FROM", ""),
    TLS_CERT: pick("TLS_CERT", ""),
    TLS_KEY: pick("TLS_KEY", ""),
    LOG_MAIL_TO_OUTBOX: bool(pick("LOG_MAIL_TO_OUTBOX", true))
  };
  if (!cfg.APP_URL) cfg.APP_URL = (cfg.TLS_CERT ? "https" : "http") + "://localhost:" + cfg.PORT;
  return cfg;
}
const CFG = loadConfig();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const store = new Store({ dir: CFG.DATA_DIR, key: CFG.DATA_KEY });
const mailer = new Mailer({
  host: CFG.SMTP_HOST, port: CFG.SMTP_PORT, secure: CFG.SMTP_SECURE, requireTls: CFG.SMTP_REQUIRE_TLS,
  user: CFG.SMTP_USER, pass: CFG.SMTP_PASS, from: CFG.MAIL_FROM || (CFG.SMTP_USER ? CFG.DEALER_NAME + " Enquiry Tracker <" + CFG.SMTP_USER + ">" : ""),
  outboxFile: CFG.LOG_MAIL_TO_OUTBOX ? path.join(CFG.DATA_DIR, "outbox.log") : ""
}, log);
const db = store.data;
const loginLimiter = new auth.RateLimiter(10, 15 * 60 * 1000);
const forgotLimiter = new auth.RateLimiter(5, 60 * 60 * 1000);
const registerLimiter = new auth.RateLimiter(10, 60 * 60 * 1000);
const SECURE_COOKIE = /^https:/i.test(CFG.APP_URL) || !!CFG.TLS_CERT;

// ---- helpers ---------------------------------------------------------------
const now = () => new Date().toISOString();
const DEPARTMENTS = ["service", "parts", "management"];
const PREFERRED = ["call", "text", "email"];
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 500);
const lower = (v) => str(v, 200).toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clientIp = (req) => (req.socket && req.socket.remoteAddress) || "?";

function findUser(id) { return db.users.find((u) => u.id === id) || null; }
function findUserByEmail(email) { const e = lower(email); return db.users.find((u) => u.email === e) || null; }
function isAdminEmail(email) { const e = lower(email); return e === CFG.APPROVER_EMAIL || CFG.ADMIN_EMAILS.includes(e); }
function displayName(u) { return u ? u.name : ""; }
function publicUser(u, full) {
  const base = { id: u.id, name: u.name, email: u.email, department: u.department, role: u.role, status: u.status };
  if (full) Object.assign(base, { createdAt: u.createdAt, approvedAt: u.approvedAt || null, lastLoginAt: u.lastLoginAt || null, hasPassword: !!u.passwordHash });
  return base;
}
function domainAllowed(email) {
  if (!CFG.ALLOWED_EMAIL_DOMAINS.length) return true;
  const d = lower(email).split("@")[1] || "";
  return CFG.ALLOWED_EMAIL_DOMAINS.includes(d);
}
function link(hash) { return CFG.APP_URL + "/#" + hash; }

// ---- sessions ------------------------------------------------------------
function pruneSessions() {
  const t = Date.now();
  db.sessions = db.sessions.filter((s) => new Date(s.expiresAt).getTime() > t);
  db.tokens = db.tokens.filter((s) => new Date(s.expiresAt).getTime() > t);
  const cutoff = t - 90 * 24 * 3600 * 1000;
  db.notifications = db.notifications.filter((n) => new Date(n.createdAt).getTime() > cutoff);
}
setInterval(() => { pruneSessions(); store.save(); }, 10 * 60 * 1000).unref();

function createSession(user, req) {
  const token = auth.randomToken(32);
  db.sessions.push({ hash: auth.sha256(token), userId: user.id, createdAt: now(), lastSeenAt: now(),
    expiresAt: new Date(Date.now() + CFG.SESSION_HOURS * 3600 * 1000).toISOString(), ua: str(req.headers["user-agent"], 200) });
  if (db.sessions.length > 2000) db.sessions.splice(0, db.sessions.length - 2000);
  store.save();
  return token;
}
function sessionUser(req, ctx) {
  const token = ctx.cookies.pm_session;
  if (!token) return null;
  const h = auth.sha256(token);
  const s = db.sessions.find((x) => x.hash === h);
  if (!s || new Date(s.expiresAt).getTime() < Date.now()) return null;
  const u = findUser(s.userId);
  if (!u || u.status !== "active") return null;
  // sliding expiry
  const t = Date.now();
  if (t - new Date(s.lastSeenAt).getTime() > 60000) {
    s.lastSeenAt = now(); s.expiresAt = new Date(t + CFG.SESSION_HOURS * 3600 * 1000).toISOString(); store.save();
  }
  ctx.session = s;
  return u;
}
function requireUser(req, ctx) {
  const u = sessionUser(req, ctx);
  if (!u) throw new HttpError(401, "Please sign in.");
  if (req.method !== "GET" && req.headers["x-requested-with"] !== "PrestonMazdaTracker") throw new HttpError(403, "Request rejected.");
  ctx.user = u;
  return u;
}
function requireAdmin(req, ctx) {
  const u = requireUser(req, ctx);
  if (u.role !== "admin") throw new HttpError(403, "Only an administrator can do that.");
  return u;
}
function setSessionCookie(res, token) { res.setHeader("Set-Cookie", cookie("pm_session", token, { maxAge: Math.round(CFG.SESSION_HOURS * 3600), secure: SECURE_COOKIE })); }
function clearSessionCookie(res) { res.setHeader("Set-Cookie", cookie("pm_session", "", { maxAge: 0, secure: SECURE_COOKIE })); }

// ---- one-time tokens (password reset / invite) -----------------------------
function issueToken(user, purpose, hours) {
  db.tokens = db.tokens.filter((t) => !(t.userId === user.id && t.purpose === purpose));
  const token = auth.randomToken(32);
  db.tokens.push({ hash: auth.sha256(token), userId: user.id, purpose, createdAt: now(), expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString() });
  store.save();
  return token;
}
function consumeToken(token, purposes) {
  const h = auth.sha256(String(token || ""));
  const idx = db.tokens.findIndex((t) => t.hash === h && purposes.includes(t.purpose));
  if (idx < 0) return null;
  const t = db.tokens[idx];
  db.tokens.splice(idx, 1);
  if (new Date(t.expiresAt).getTime() < Date.now()) return null;
  return t;
}

// ---- live events (Server-Sent Events) ---------------------------------------
const sseClients = new Set(); // { res, userId }
function broadcast(event, payload, onlyUserId) {
  const msg = "event: " + event + "\ndata: " + JSON.stringify(payload || {}) + "\n\n";
  for (const c of sseClients) {
    if (onlyUserId && c.userId !== onlyUserId) continue;
    try { c.res.write(msg); } catch (e) { sseClients.delete(c); }
  }
}
setInterval(() => { for (const c of sseClients) { try { c.res.write(": ping\n\n"); } catch (e) { sseClients.delete(c); } } }, 25000).unref();

// ---- notifications & email -------------------------------------------------
function notify(userIds, n) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  ids.forEach((userId) => {
    const rec = { id: auth.newId("n"), userId, type: n.type, title: n.title, body: n.body, enquiryId: n.enquiryId || null, createdAt: now(), readAt: null };
    db.notifications.push(rec);
    broadcast("notification", rec, userId);
    if (n.email !== false) {
      const u = findUser(userId);
      if (u && u.status === "active") sendEnquiryMail(u.email, n.title, n.body, n.enquiryId);
    }
  });
  if (ids.length) store.save();
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function mailWrap(title, bodyLines, ctaText, ctaHref) {
  const text = [title, "", ...bodyLines, "", ctaText + ": " + ctaHref, "", "— " + CFG.DEALER_NAME + " Customer Enquiry Tracker"].join("\n");
  const html = '<div style="font-family:Helvetica Neue,Helvetica,Arial,sans-serif;font-size:15px;color:#101010;max-width:560px">' +
    '<div style="background:#101010;border-bottom:4px solid #c8102e;padding:14px 18px;color:#fff;font-weight:700;font-size:16px">' + esc(CFG.DEALER_NAME) + ' · Customer Enquiry Tracker</div>' +
    '<div style="padding:18px"><h2 style="margin:0 0 12px;font-size:18px">' + esc(title) + '</h2>' +
    bodyLines.map((l) => '<p style="margin:0 0 6px">' + esc(l) + '</p>').join("") +
    '<p style="margin:18px 0 0"><a href="' + esc(ctaHref) + '" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">' + esc(ctaText) + '</a></p>' +
    '<p style="margin:16px 0 0;font-size:12px;color:#7a7f86">This alert was sent by the ' + esc(CFG.DEALER_NAME) + ' Customer Enquiry Tracker, which runs on the dealership network.</p></div></div>';
  return { text, html };
}
function enquiryLines(e) {
  const adv = findUser(e.advisor.userId), parts = findUser(e.parts.userId);
  const lines = [
    "Customer: " + e.customer.name + (e.customer.registration ? " · " + e.customer.registration : ""),
    "Contact: " + (e.customer.phone || "—") + " · " + (e.customer.email || "—") + " · prefers " + labelPreferred(e.customer.preferred),
    "Enquiry: " + (e.enquiry || "—")
  ];
  if (adv) lines.push("Service advisor: " + adv.name);
  if (parts) lines.push("Parts: " + parts.name);
  return lines;
}
function labelPreferred(p) { return { call: "a phone call", text: "a text message", email: "an email" }[p] || "—"; }
function sendEnquiryMail(to, subject, body, enquiryId) {
  const e = enquiryId ? db.enquiries.find((x) => x.id === enquiryId) : null;
  const lines = [body].concat(e ? [""].concat(enquiryLines(e)) : []);
  const m = mailWrap(subject, lines, e ? "Open enquiry " + e.ref : "Open the tracker", e ? link("/enquiry/" + e.id) : link("/"));
  mailer.send({ to, subject: "[" + CFG.DEALER_NAME + "] " + subject, text: m.text, html: m.html });
}

/** Compare before/after and fire the right alerts. `before` is null for a new enquiry. */
function enquiryAlerts(before, after, actor) {
  const b = before || { advisor: {}, parts: {}, customer: {} };
  const who = actor ? actor.name : "Someone";
  const cust = after.customer.name + (after.customer.registration ? " (" + after.customer.registration + ")" : "");

  // Allocation to a specific service advisor → email + pop-up for that advisor
  if (after.advisor.userId && after.advisor.userId !== b.advisor.userId && after.advisor.userId !== (actor && actor.id)) {
    notify([after.advisor.userId], { type: "allocated", enquiryId: after.id, title: "Enquiry " + after.ref + " allocated to you", body: who + " allocated the enquiry from " + cust + " to you as service advisor." });
  }
  // Allocation to a specific parts person
  if (after.parts.userId && after.parts.userId !== b.parts.userId && after.parts.userId !== (actor && actor.id)) {
    notify([after.parts.userId], { type: "allocated", enquiryId: after.id, title: "Parts task " + after.ref + " allocated to you", body: who + " allocated the parts quote for " + cust + " to you." });
  }
  // Parts quote required → parts@ mailbox (+ pop-up for the parts department)
  if (after.parts.quoteRequired && !b.parts.quoteRequired) {
    sendEnquiryMail(CFG.PARTS_EMAIL, "Parts quote required – " + cust, who + " has flagged that a parts quote is required for enquiry " + after.ref + ".", after.id);
    const partsUsers = db.users.filter((u) => u.status === "active" && u.department === "parts" && u.id !== (actor && actor.id)).map((u) => u.id);
    notify(partsUsers, { type: "parts", enquiryId: after.id, title: "Parts quote required – " + after.ref, body: who + " needs a parts quote for " + cust + ".", email: false });
  }
  // Service advisor needs to contact the customer → advisors@ mailbox (+ pop-up)
  if (after.advisor.contactRequired && !b.advisor.contactRequired) {
    sendEnquiryMail(CFG.ADVISORS_EMAIL, "Customer contact required – " + cust, who + " has flagged that a service advisor needs to contact " + cust + " (enquiry " + after.ref + ").", after.id);
    const targets = after.advisor.userId ? [after.advisor.userId] : db.users.filter((u) => u.status === "active" && u.department === "service").map((u) => u.id);
    notify(targets.filter((id) => id !== (actor && actor.id)), { type: "contact", enquiryId: after.id, title: "Customer contact required – " + after.ref, body: cust + " needs to be contacted by a service advisor. Preferred method: " + labelPreferred(after.customer.preferred) + ".", email: false });
  }
  // Parts finished their quote → tell the allocated advisor (email + pop-up)
  if (after.parts.done && !b.parts.done && after.advisor.userId && after.advisor.userId !== (actor && actor.id)) {
    notify([after.advisor.userId], { type: "parts-done", enquiryId: after.id, title: "Parts quote ready – " + after.ref, body: who + " marked the parts quote for " + cust + " as done." });
  }
  // Advisor finished → tell the allocated parts person (pop-up only)
  if (after.advisor.done && !b.advisor.done && after.parts.userId && after.parts.userId !== (actor && actor.id)) {
    notify([after.parts.userId], { type: "advisor-done", enquiryId: after.id, title: "Advisor task done – " + after.ref, body: who + " marked the service advisor task for " + cust + " as done.", email: false });
  }
}

// ---- enquiry model -------------------------------------------------------------
function nextRef() { db.counters.enquiry = (db.counters.enquiry || 0) + 1; return "E-" + String(db.counters.enquiry).padStart(4, "0"); }
function findEnquiry(id) { const e = db.enquiries.find((x) => x.id === id); if (!e) throw new HttpError(404, "Enquiry not found."); return e; }
function validUserId(id, department) {
  if (!id) return null;
  const u = findUser(id);
  if (!u || u.status !== "active") throw new HttpError(400, "That user is not active.");
  if (department && u.department !== department && u.role !== "admin") throw new HttpError(400, "That user is not in the " + department + " department.");
  return u.id;
}
function applyEnquiryInput(e, input, actor, isNew) {
  const c = input.customer || {};
  if (isNew || input.customer) {
    // Partial updates are allowed: only the keys present are changed.
    const cur = e.customer || {};
    const has = (k) => isNew || Object.prototype.hasOwnProperty.call(c, k);
    e.customer = {
      name: has("name") ? str(c.name, 120) : cur.name,
      registration: has("registration") ? str(c.registration, 20).toUpperCase() : (cur.registration || ""),
      phone: has("phone") ? str(c.phone, 40) : (cur.phone || ""),
      email: has("email") ? lower(c.email) : (cur.email || ""),
      preferred: has("preferred") ? (PREFERRED.includes(c.preferred) ? c.preferred : "call") : (cur.preferred || "call")
    };
    if (!e.customer.name) throw new HttpError(400, "Customer name is required.");
    if (e.customer.email && !isEmail(e.customer.email)) throw new HttpError(400, "Customer email address does not look right.");
  }
  if (isNew || input.enquiry !== undefined) e.enquiry = str(input.enquiry, 2000);
  if (input.status !== undefined) {
    if (!["open", "closed"].includes(input.status)) throw new HttpError(400, "Invalid status.");
    if (input.status !== e.status) { e.status = input.status; e.closedAt = input.status === "closed" ? now() : null; e.closedBy = input.status === "closed" ? actor.id : null; }
  }
  if (input.advisor) {
    const a = input.advisor;
    if (a.userId !== undefined) e.advisor.userId = validUserId(a.userId, "service");
    if (a.contactRequired !== undefined) e.advisor.contactRequired = !!a.contactRequired;
    if (a.done !== undefined && !!a.done !== e.advisor.done) { e.advisor.done = !!a.done; e.advisor.doneAt = a.done ? now() : null; e.advisor.doneBy = a.done ? actor.id : null; e.advisor.doneByName = a.done ? actor.name : null; }
  }
  if (input.parts) {
    const p = input.parts;
    if (p.userId !== undefined) e.parts.userId = validUserId(p.userId, "parts");
    if (p.quoteRequired !== undefined) e.parts.quoteRequired = !!p.quoteRequired;
    if (p.done !== undefined && !!p.done !== e.parts.done) { e.parts.done = !!p.done; e.parts.doneAt = p.done ? now() : null; e.parts.doneBy = p.done ? actor.id : null; e.parts.doneByName = p.done ? actor.name : null; }
  }
  e.updatedAt = now(); e.updatedBy = actor.id; e.updatedByName = actor.name;
}
function newEnquiry(actor) {
  return { id: auth.newId("e"), ref: nextRef(), customer: {}, enquiry: "", status: "open",
    advisor: { userId: null, contactRequired: false, done: false, doneAt: null, doneBy: null, doneByName: null },
    parts: { userId: null, quoteRequired: false, done: false, doneAt: null, doneBy: null, doneByName: null },
    attachments: [], notes: [], createdAt: now(), createdBy: actor.id, createdByName: actor.name, updatedAt: now(), closedAt: null };
}

// ---- app & routes ----------------------------------------------------------
const app = new App();
const UPLOAD_LIMIT = Math.round(CFG.MAX_UPLOAD_MB * 1048576);

app.get("/api/config", () => ({
  dealerName: CFG.DEALER_NAME, approverEmail: CFG.APPROVER_EMAIL, partsEmail: CFG.PARTS_EMAIL, advisorsEmail: CFG.ADVISORS_EMAIL,
  allowedDomains: CFG.ALLOWED_EMAIL_DOMAINS, mailConfigured: mailer.configured, encrypted: !!CFG.DATA_KEY, departments: DEPARTMENTS, preferred: PREFERRED, maxUploadMb: CFG.MAX_UPLOAD_MB
}));

// -- auth
app.post("/api/auth/register", async (req, res, ctx) => {
  if (!registerLimiter.hit(clientIp(req))) throw new HttpError(429, "Too many registrations from this computer. Try again later.");
  const b = await readJson(req);
  const name = str(b.name, 80), email = lower(b.email), department = DEPARTMENTS.includes(b.department) ? b.department : "service";
  if (!name) throw new HttpError(400, "Please enter your name.");
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!domainAllowed(email)) throw new HttpError(400, "Please use your work email address (" + CFG.ALLOWED_EMAIL_DOMAINS.map((d) => "@" + d).join(", ") + ").");
  const pp = auth.passwordProblem(b.password, email);
  if (pp) throw new HttpError(400, pp);
  const existing = findUserByEmail(email);
  if (existing && existing.passwordHash) throw new HttpError(409, "An account with that email address already exists. Try signing in or resetting your password.");
  const admin = isAdminEmail(email);
  const user = existing || { id: auth.newId("u"), email, createdAt: now() };
  Object.assign(user, { name, department, passwordHash: auth.hashPassword(b.password), role: admin ? "admin" : (user.role || "staff") });
  if (admin) { user.status = "active"; user.approvedAt = now(); user.approvedBy = "system"; }
  else if (user.status !== "active") user.status = "pending";
  if (!existing) db.users.push(user);
  store.save();
  if (user.status === "pending") {
    const approver = findUserByEmail(CFG.APPROVER_EMAIL);
    const m = mailWrap("New account request – " + name, [name + " (" + email + ", " + department + ") has requested access to the Customer Enquiry Tracker.", "Please approve or decline the request."], "Review requests", link("/users"));
    mailer.send({ to: CFG.APPROVER_EMAIL, subject: "[" + CFG.DEALER_NAME + "] Account approval needed – " + name, text: m.text, html: m.html });
    if (approver) notify([approver.id], { type: "approval", title: "Account request from " + name, body: email + " (" + department + ") is waiting for approval.", email: false });
    broadcast("users", { action: "pending" });
    return { status: "pending", message: "Thanks " + name + ". Your account has been sent to " + CFG.APPROVER_EMAIL + " for approval. You will get an email once it is approved." };
  }
  const token = createSession(user, req);
  setSessionCookie(res, token);
  return { status: "active", user: publicUser(user) };
});

app.post("/api/auth/login", async (req, res, ctx) => {
  const b = await readJson(req);
  const email = lower(b.email);
  const key = clientIp(req) + "|" + email;
  if (!loginLimiter.hit(key)) throw new HttpError(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
  const user = findUserByEmail(email);
  const ok = user && user.passwordHash && auth.verifyPassword(String(b.password || ""), user.passwordHash);
  if (!ok) throw new HttpError(401, "Email address or password is incorrect.");
  if (user.status === "pending") throw new HttpError(403, "Your account is still waiting for approval by " + CFG.APPROVER_EMAIL + ".", { status: "pending" });
  if (user.status !== "active") throw new HttpError(403, "This account has been disabled. Contact " + CFG.APPROVER_EMAIL + ".", { status: "disabled" });
  loginLimiter.reset(key);
  user.lastLoginAt = now();
  const token = createSession(user, req);
  setSessionCookie(res, token);
  return { user: publicUser(user) };
});

app.post("/api/auth/logout", (req, res, ctx) => {
  const u = sessionUser(req, ctx);
  if (u && ctx.session) { db.sessions = db.sessions.filter((s) => s !== ctx.session); store.save(); }
  clearSessionCookie(res);
  return { ok: true };
});

app.get("/api/auth/me", (req, res, ctx) => {
  const u = sessionUser(req, ctx);
  if (!u) throw new HttpError(401, "Not signed in.");
  return { user: publicUser(u), unread: db.notifications.filter((n) => n.userId === u.id && !n.readAt).length };
});

app.post("/api/auth/forgot", async (req) => {
  if (!forgotLimiter.hit(clientIp(req))) throw new HttpError(429, "Too many reset requests. Please try again later.");
  const b = await readJson(req);
  const user = findUserByEmail(b.email);
  if (user && user.status !== "disabled") {
    const token = issueToken(user, "reset", 1);
    const m = mailWrap("Reset your password", ["Hi " + user.name + ",", "Someone (hopefully you) asked to reset the password for your Customer Enquiry Tracker account.", "The link below works for 1 hour. If you did not ask for this you can ignore this email."], "Choose a new password", link("/reset?token=" + token));
    mailer.send({ to: user.email, subject: "[" + CFG.DEALER_NAME + "] Password reset", text: m.text, html: m.html });
  }
  return { ok: true, message: "If that email address has an account, a reset link has been sent to it." };
});

app.post("/api/auth/reset", async (req, res) => {
  const b = await readJson(req);
  const t = consumeToken(b.token, ["reset", "invite"]);
  if (!t) throw new HttpError(400, "This link is invalid or has expired. Please request a new one.");
  const user = findUser(t.userId);
  if (!user) throw new HttpError(400, "Account no longer exists.");
  const pp = auth.passwordProblem(b.password, user.email);
  if (pp) throw new HttpError(400, pp);
  user.passwordHash = auth.hashPassword(b.password);
  db.sessions = db.sessions.filter((s) => s.userId !== user.id); // sign out everywhere else
  if (user.status === "active") { const token = createSession(user, req); setSessionCookie(res, token); }
  store.save();
  return { ok: true, status: user.status, user: user.status === "active" ? publicUser(user) : null };
});

app.post("/api/auth/change-password", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const b = await readJson(req);
  if (!auth.verifyPassword(String(b.current || ""), u.passwordHash)) throw new HttpError(400, "Current password is incorrect.");
  const pp = auth.passwordProblem(b.password, u.email);
  if (pp) throw new HttpError(400, pp);
  u.passwordHash = auth.hashPassword(b.password);
  db.sessions = db.sessions.filter((s) => s.userId !== u.id || s === ctx.session);
  store.save();
  return { ok: true };
});

// -- users
app.get("/api/users", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const full = u.role === "admin";
  const list = db.users.filter((x) => full || x.status === "active").map((x) => publicUser(x, full));
  return { users: list, mail: full ? { configured: mailer.configured, recent: mailer.sent.slice(0, 10) } : undefined };
});

app.post("/api/users", async (req, res, ctx) => {
  const admin = requireAdmin(req, ctx);
  const b = await readJson(req);
  const name = str(b.name, 80), email = lower(b.email);
  if (!name) throw new HttpError(400, "Name is required.");
  if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!domainAllowed(email)) throw new HttpError(400, "Only work email addresses can be added (" + CFG.ALLOWED_EMAIL_DOMAINS.map((d) => "@" + d).join(", ") + ").");
  if (findUserByEmail(email)) throw new HttpError(409, "A user with that email already exists.");
  const user = { id: auth.newId("u"), name, email, department: DEPARTMENTS.includes(b.department) ? b.department : "service",
    role: b.role === "admin" || isAdminEmail(email) ? "admin" : "staff", status: "active", passwordHash: null,
    createdAt: now(), approvedAt: now(), approvedBy: admin.id };
  db.users.push(user);
  const token = issueToken(user, "invite", 72);
  const m = mailWrap("You have been added to the Customer Enquiry Tracker", ["Hi " + name + ",", admin.name + " has created an account for you. Choose a password to start using the tracker.", "The link below works for 72 hours."], "Set your password", link("/reset?token=" + token));
  mailer.send({ to: email, subject: "[" + CFG.DEALER_NAME + "] Your enquiry tracker account", text: m.text, html: m.html });
  store.save();
  broadcast("users", { action: "added" });
  return { user: publicUser(user, true) };
});

app.patch("/api/users/:id", async (req, res, ctx) => {
  const admin = requireAdmin(req, ctx);
  const user = findUser(ctx.params.id);
  if (!user) throw new HttpError(404, "User not found.");
  const b = await readJson(req);
  if (b.name !== undefined) { const n = str(b.name, 80); if (!n) throw new HttpError(400, "Name is required."); user.name = n; }
  if (b.department !== undefined) { if (!DEPARTMENTS.includes(b.department)) throw new HttpError(400, "Invalid department."); user.department = b.department; }
  if (b.role !== undefined) {
    if (!["admin", "staff"].includes(b.role)) throw new HttpError(400, "Invalid role.");
    if (user.id === admin.id && b.role !== "admin") throw new HttpError(400, "You cannot remove your own administrator access.");
    if (isAdminEmail(user.email) && b.role !== "admin") throw new HttpError(400, "The approver account must stay an administrator.");
    user.role = b.role;
  }
  if (b.status !== undefined) {
    if (!["active", "disabled"].includes(b.status)) throw new HttpError(400, "Invalid status.");
    if (user.id === admin.id && b.status !== "active") throw new HttpError(400, "You cannot disable your own account.");
    const was = user.status;
    user.status = b.status;
    if (b.status === "active" && was !== "active") { user.approvedAt = now(); user.approvedBy = admin.id; }
    if (b.status !== "active") db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    if (was === "pending" && b.status === "active") {
      const m = mailWrap("Your account has been approved", ["Hi " + user.name + ",", admin.name + " has approved your Customer Enquiry Tracker account. You can sign in now with the password you chose."], "Sign in", link("/login"));
      mailer.send({ to: user.email, subject: "[" + CFG.DEALER_NAME + "] Account approved", text: m.text, html: m.html });
    }
  }
  store.save();
  broadcast("users", { action: "updated", userId: user.id });
  return { user: publicUser(user, true) };
});

app.delete("/api/users/:id", (req, res, ctx) => {
  const admin = requireAdmin(req, ctx);
  const idx = db.users.findIndex((u) => u.id === ctx.params.id);
  if (idx < 0) throw new HttpError(404, "User not found.");
  const user = db.users[idx];
  if (user.id === admin.id) throw new HttpError(400, "You cannot delete your own account.");
  if (user.status === "pending") {
    const m = mailWrap("Account request declined", ["Hi " + user.name + ",", "Your request for access to the Customer Enquiry Tracker was not approved. Please speak to " + CFG.APPROVER_EMAIL + " if you think this is a mistake."], "Open the tracker", link("/login"));
    mailer.send({ to: user.email, subject: "[" + CFG.DEALER_NAME + "] Account request declined", text: m.text, html: m.html });
  }
  db.users.splice(idx, 1);
  db.sessions = db.sessions.filter((s) => s.userId !== user.id);
  db.tokens = db.tokens.filter((t) => t.userId !== user.id);
  store.save();
  broadcast("users", { action: "removed", userId: user.id });
  return { ok: true };
});

app.post("/api/users/:id/send-reset", (req, res, ctx) => {
  const admin = requireAdmin(req, ctx);
  const user = findUser(ctx.params.id);
  if (!user) throw new HttpError(404, "User not found.");
  const token = issueToken(user, "invite", 72);
  const m = mailWrap("Set a new password", ["Hi " + user.name + ",", admin.name + " has sent you a link to choose a new password for the Customer Enquiry Tracker.", "The link below works for 72 hours."], "Choose a password", link("/reset?token=" + token));
  mailer.send({ to: user.email, subject: "[" + CFG.DEALER_NAME + "] Set your password", text: m.text, html: m.html });
  return { ok: true };
});

// -- enquiries
app.get("/api/enquiries", (req, res, ctx) => {
  requireUser(req, ctx);
  const status = ctx.query.get("status") || "open";
  const list = db.enquiries.filter((e) => status === "all" || e.status === status)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { enquiries: list, counts: { open: db.enquiries.filter((e) => e.status === "open").length, closed: db.enquiries.filter((e) => e.status === "closed").length } };
});

app.get("/api/enquiries/:id", (req, res, ctx) => { requireUser(req, ctx); return { enquiry: findEnquiry(ctx.params.id) }; });

app.post("/api/enquiries", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const b = await readJson(req);
  const e = newEnquiry(u);
  applyEnquiryInput(e, b, u, true);
  db.enquiries.push(e);
  store.save();
  enquiryAlerts(null, e, u);
  broadcast("enquiries", { action: "created", id: e.id, by: u.name });
  return { enquiry: e };
});

app.patch("/api/enquiries/:id", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const before = JSON.parse(JSON.stringify(e));
  const b = await readJson(req);
  applyEnquiryInput(e, b, u, false);
  store.save();
  enquiryAlerts(before, e, u);
  broadcast("enquiries", { action: "updated", id: e.id, by: u.name });
  return { enquiry: e };
});

app.delete("/api/enquiries/:id", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  if (u.role !== "admin" && e.createdBy !== u.id) throw new HttpError(403, "Only the person who logged this enquiry or an administrator can delete it.");
  db.enquiries = db.enquiries.filter((x) => x.id !== e.id);
  store.deleteAttachmentsFor(e.id);
  store.save();
  broadcast("enquiries", { action: "deleted", id: e.id, by: u.name });
  return { ok: true };
});

// -- notes
app.post("/api/enquiries/:id/notes", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const b = await readJson(req);
  const text = str(b.text, 4000);
  if (!text) throw new HttpError(400, "Please write something in the note.");
  const note = { id: auth.newId("nt"), text, spokeWith: str(b.spokeWith, 80) || u.name, authorId: u.id, authorName: u.name, createdAt: now() };
  e.notes.push(note);
  e.updatedAt = now(); e.updatedBy = u.id; e.updatedByName = u.name;
  store.save();
  const cust = e.customer.name + (e.customer.registration ? " (" + e.customer.registration + ")" : "");
  notify([e.advisor.userId, e.parts.userId].filter((id) => id && id !== u.id), { type: "note", enquiryId: e.id, title: "New note on " + e.ref, body: u.name + " added a note about " + cust + ": " + text.slice(0, 140), email: false });
  broadcast("enquiries", { action: "note", id: e.id, by: u.name });
  return { note, enquiry: e };
});

app.delete("/api/enquiries/:id/notes/:noteId", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const n = e.notes.find((x) => x.id === ctx.params.noteId);
  if (!n) throw new HttpError(404, "Note not found.");
  if (u.role !== "admin" && n.authorId !== u.id) throw new HttpError(403, "Only the author or an administrator can delete a note.");
  e.notes = e.notes.filter((x) => x !== n);
  e.updatedAt = now();
  store.save();
  broadcast("enquiries", { action: "note", id: e.id, by: u.name });
  return { enquiry: e };
});

// -- attachments (PDF parts quotes)
app.post("/api/enquiries/:id/attachments", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const name = str(ctx.query.get("filename"), 150).replace(/[\\/:*?"<>|]/g, "_") || "quote.pdf";
  if (!/\.pdf$/i.test(name)) throw new HttpError(400, "Only PDF files can be attached.");
  const declared = parseInt(req.headers["content-length"] || "0", 10);
  if (declared > UPLOAD_LIMIT) throw new HttpError(413, "Upload is too large (limit " + CFG.MAX_UPLOAD_MB + " MB).");
  const buf = await readBody(req, UPLOAD_LIMIT);
  if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "That file is not a PDF.");
  if (e.attachments.length >= 20) throw new HttpError(400, "An enquiry can hold up to 20 attachments.");
  const att = { id: auth.newId("a"), name, size: buf.length, uploadedBy: u.id, uploadedByName: u.name, uploadedAt: now() };
  store.writeAttachment(e.id, att.id, buf);
  e.attachments.push(att);
  e.updatedAt = now(); e.updatedBy = u.id; e.updatedByName = u.name;
  store.save();
  const cust = e.customer.name + (e.customer.registration ? " (" + e.customer.registration + ")" : "");
  notify([e.advisor.userId].filter((id) => id && id !== u.id), { type: "attachment", enquiryId: e.id, title: "Quote attached to " + e.ref, body: u.name + " attached " + name + " to the enquiry from " + cust + ".", email: false });
  broadcast("enquiries", { action: "attachment", id: e.id, by: u.name });
  return { attachment: att, enquiry: e };
});

app.get("/api/enquiries/:id/attachments/:attId", (req, res, ctx) => {
  requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const att = e.attachments.find((a) => a.id === ctx.params.attId);
  if (!att) throw new HttpError(404, "Attachment not found.");
  const buf = store.readAttachment(e.id, att.id);
  if (!buf) throw new HttpError(404, "Attachment file is missing.");
  const dl = ctx.query.get("download") === "1";
  res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": buf.length, "Cache-Control": "private, no-store",
    "Content-Disposition": (dl ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(att.name) });
  res.end(buf);
});

app.delete("/api/enquiries/:id/attachments/:attId", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const e = findEnquiry(ctx.params.id);
  const att = e.attachments.find((a) => a.id === ctx.params.attId);
  if (!att) throw new HttpError(404, "Attachment not found.");
  if (u.role !== "admin" && att.uploadedBy !== u.id) throw new HttpError(403, "Only the uploader or an administrator can remove an attachment.");
  store.deleteAttachment(e.id, att.id);
  e.attachments = e.attachments.filter((a) => a !== att);
  e.updatedAt = now();
  store.save();
  broadcast("enquiries", { action: "attachment", id: e.id, by: u.name });
  return { enquiry: e };
});

// -- notifications
app.get("/api/notifications", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const list = db.notifications.filter((n) => n.userId === u.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100);
  return { notifications: list, unread: list.filter((n) => !n.readAt).length };
});
app.post("/api/notifications/read", async (req, res, ctx) => {
  const u = requireUser(req, ctx);
  const b = await readJson(req);
  const ids = Array.isArray(b.ids) ? b.ids : null;
  db.notifications.forEach((n) => { if (n.userId === u.id && !n.readAt && (!ids || ids.includes(n.id))) n.readAt = now(); });
  store.save();
  return { unread: db.notifications.filter((n) => n.userId === u.id && !n.readAt).length };
});

// -- live stream
app.get("/api/events", (req, res, ctx) => {
  const u = requireUser(req, ctx);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  res.write("event: hello\ndata: " + JSON.stringify({ userId: u.id, at: now() }) + "\n\n");
  const client = { res, userId: u.id };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

// -- static files: the tracker UI first, then the shared dashboard brand assets
app.static("/assets/", path.join(__dirname, "..", "assets"));
app.static("/", path.join(__dirname, "public"));

// The shared stylesheet lives in the dashboard folder; expose just that file.
const sharedCss = path.join(__dirname, "..", "css", "styles.css");
app.get("/css/styles.css", (req, res) => {
  const st = fs.statSync(sharedCss);
  res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Content-Length": st.size, "Cache-Control": "public, max-age=3600" });
  fs.createReadStream(sharedCss).pipe(res);
});

// ---- start -------------------------------------------------------------------
function start() {
  pruneSessions();
  const handler = app.handler();
  const server = CFG.TLS_CERT
    ? https.createServer({ cert: fs.readFileSync(CFG.TLS_CERT), key: fs.readFileSync(CFG.TLS_KEY) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 120000;
  server.listen(CFG.PORT, CFG.HOST, () => {
    log("Preston Mazda Customer Enquiry Tracker");
    log("Listening on " + (CFG.TLS_CERT ? "https" : "http") + "://" + CFG.HOST + ":" + CFG.PORT + "  (APP_URL " + CFG.APP_URL + ")");
    log("Data folder: " + CFG.DATA_DIR + (CFG.DATA_KEY ? " (encrypted at rest)" : " (not encrypted – set DATA_KEY to enable)"));
    log("Approver: " + CFG.APPROVER_EMAIL + " · Parts alerts: " + CFG.PARTS_EMAIL + " · Advisor alerts: " + CFG.ADVISORS_EMAIL);
    log(mailer.configured ? "Email: via " + CFG.SMTP_HOST + ":" + CFG.SMTP_PORT : "Email: SMTP not configured – alerts are written to data/outbox.log until it is");
    if (!db.users.length) log("No users yet. Register with " + CFG.APPROVER_EMAIL + " to create the first administrator.");
  });
  const shutdown = () => { store.flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  process.on("exit", () => store.flush());
  return server;
}

if (require.main === module) start();
module.exports = { start, app, CFG, store, mailer };

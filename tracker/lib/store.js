/* =====================================================================
   store.js – on-disk JSON store for the enquiry tracker.

   Everything lives in ONE file (data/db.json) that is written atomically
   (write to a temp file, then rename) so a power cut never leaves a
   half-written database. When DATA_KEY is set the file is encrypted at
   rest with AES-256-GCM. Nothing is ever sent off the machine.
   ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAGIC = Buffer.from("PMENC1");

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Encrypt a buffer with a passphrase. Layout: MAGIC | salt16 | iv12 | tag16 | ciphertext */
function seal(buf, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]);
}

/** Decrypt a buffer produced by seal(). Plain (unencrypted) buffers pass through. */
function open(buf, passphrase) {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return buf;
  if (!passphrase) throw new Error("The data file is encrypted but DATA_KEY is not set.");
  const salt = buf.subarray(6, 22);
  const iv = buf.subarray(22, 34);
  const tag = buf.subarray(34, 50);
  const enc = buf.subarray(50);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function emptyDb() {
  return {
    version: 1,
    users: [],
    sessions: [],
    tokens: [],
    enquiries: [],
    notifications: [],
    counters: { enquiry: 0 },
    loginAttempts: {}
  };
}

class Store {
  constructor(opts) {
    this.dir = opts.dir;
    this.file = path.join(this.dir, "db.json");
    this.uploadsDir = path.join(this.dir, "uploads");
    this.key = opts.key || "";
    this.data = emptyDb();
    this._dirty = false;
    this._timer = null;
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const raw = open(fs.readFileSync(this.file), this.key);
    const parsed = JSON.parse(raw.toString("utf8"));
    this.data = Object.assign(emptyDb(), parsed);
  }

  /** Mark dirty and write shortly (debounced so bursts of changes coalesce). */
  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 40);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    this._dirty = false;
    let buf = Buffer.from(JSON.stringify(this.data, null, 1), "utf8");
    if (this.key) buf = seal(buf, this.key);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- file attachments ------------------------------------------------
  attachmentPath(enquiryId, attachmentId) {
    const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "");
    return path.join(this.uploadsDir, safe(enquiryId), safe(attachmentId) + ".pdf");
  }
  writeAttachment(enquiryId, attachmentId, buf) {
    const p = this.attachmentPath(enquiryId, attachmentId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.key ? seal(buf, this.key) : buf, { mode: 0o600 });
  }
  readAttachment(enquiryId, attachmentId) {
    const p = this.attachmentPath(enquiryId, attachmentId);
    if (!fs.existsSync(p)) return null;
    return open(fs.readFileSync(p), this.key);
  }
  deleteAttachment(enquiryId, attachmentId) {
    const p = this.attachmentPath(enquiryId, attachmentId);
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  deleteAttachmentsFor(enquiryId) {
    const dir = path.dirname(this.attachmentPath(enquiryId, "x"));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = { Store, seal, open };

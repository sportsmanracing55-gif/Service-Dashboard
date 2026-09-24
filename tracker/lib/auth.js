/* =====================================================================
   auth.js – passwords, sessions and one-time tokens.
   Passwords are hashed with scrypt (salted). Session and reset tokens are
   random and only their SHA-256 hash is stored, so a copy of the data
   file cannot be used to hijack a login.
   ===================================================================== */
"use strict";
const crypto = require("crypto");

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ["scrypt", SCRYPT.N, salt.toString("base64"), hash.toString("base64")].join("$");
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const N = parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r: SCRYPT.r, p: SCRYPT.p, maxmem: Math.max(SCRYPT.maxmem, 128 * N * SCRYPT.r * 2) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Returns null when OK, otherwise a message describing what is wrong. */
function passwordProblem(password, email) {
  const p = String(password || "");
  if (p.length < 10) return "Password must be at least 10 characters long.";
  if (p.length > 200) return "Password is too long.";
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "Password must contain both letters and numbers.";
  if (email && p.toLowerCase().includes(String(email).split("@")[0].toLowerCase()) && String(email).split("@")[0].length >= 4) return "Password must not contain your email address.";
  if (/^(password|qwerty|letmein|welcome|mazda)/i.test(p)) return "That password is too easy to guess.";
  return null;
}

function randomToken(bytes) { return crypto.randomBytes(bytes || 32).toString("base64url"); }
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function newId(prefix) { return (prefix ? prefix + "_" : "") + crypto.randomBytes(9).toString("base64url"); }

/** Simple in-memory attempt limiter (per key, sliding window). */
class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.map = new Map(); }
  hit(key) {
    const now = Date.now();
    const arr = (this.map.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.map.set(key, arr);
    if (this.map.size > 5000) this.map.clear();
    return arr.length <= this.max;
  }
  reset(key) { this.map.delete(key); }
}

module.exports = { hashPassword, verifyPassword, passwordProblem, randomToken, sha256, newId, RateLimiter };

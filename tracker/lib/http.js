/* =====================================================================
   http.js – the small amount of web framework the tracker needs:
   routing with :params, JSON / raw bodies with size limits, cookies,
   static files (no directory traversal) and security headers.
   ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json"
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function json(res, status, body) {
  const s = JSON.stringify(body == null ? {} : body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s), "Cache-Control": "no-store" });
  res.end(s);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Upload is too large (limit " + Math.round(limit / 1048576) + " MB).")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit || 1048576);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch (e) { throw new HttpError(400, "Body is not valid JSON."); }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("="); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookie(name, value, opts) {
  let s = name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Strict";
  if (opts && opts.maxAge != null) s += "; Max-Age=" + opts.maxAge;
  if (opts && opts.secure) s += "; Secure";
  return s;
}

function compile(pattern) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  return { re, keys };
}

class App {
  constructor() { this.routes = []; this.statics = []; }
  route(method, pattern, handler) { const c = compile(pattern); this.routes.push({ method, re: c.re, keys: c.keys, handler }); }
  get(p, h) { this.route("GET", p, h); }
  post(p, h) { this.route("POST", p, h); }
  patch(p, h) { this.route("PATCH", p, h); }
  delete(p, h) { this.route("DELETE", p, h); }
  /** Serve files under `dir` for paths starting with `prefix` (in the order added). */
  static(prefix, dir) { this.statics.push({ prefix, dir: path.resolve(dir) }); }

  handler() {
    return async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'self'");
      try {
        for (const r of this.routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          const ctx = { params, query: url.searchParams, url, cookies: parseCookies(req) };
          const out = await r.handler(req, res, ctx);
          if (out !== undefined && !res.headersSent) json(res, 200, out);
          return;
        }
        if (req.method === "GET" || req.method === "HEAD") {
          if (this.serveStatic(url.pathname, req, res)) return;
        }
        if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
        throw new HttpError(404, "Not found.");
      } catch (err) {
        const status = err.status || 500;
        if (status === 500) console.error("[http] " + req.method + " " + url.pathname + " ->", err);
        if (!res.headersSent) json(res, status, Object.assign({ error: status === 500 ? "Something went wrong on the server." : err.message }, err.extra || {}));
        else res.end();
      }
    };
  }

  serveStatic(pathname, req, res) {
    let p = pathname === "/" ? "/index.html" : pathname;
    try { p = decodeURIComponent(p); } catch (e) { return false; }
    if (p.includes("\0") || p.includes("..")) return false;
    for (const s of this.statics) {
      if (!p.startsWith(s.prefix)) continue;
      const file = path.join(s.dir, p.slice(s.prefix.length));
      if (!file.startsWith(s.dir + path.sep) && file !== s.dir) continue;
      let st;
      try { st = fs.statSync(file); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext];
      if (!type) continue;
      const headers = { "Content-Type": type, "Content-Length": st.size, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" };
      res.writeHead(200, headers);
      if (req.method === "HEAD") { res.end(); return true; }
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }
}

module.exports = { App, HttpError, json, readBody, readJson, cookie, parseCookies };

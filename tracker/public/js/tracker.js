/* =====================================================================
   tracker.js – Preston Mazda Customer Enquiry Tracker (browser side)
   Talks to the local server over /api; live updates arrive over
   Server-Sent Events. No data is kept in the browser except the theme.
   ===================================================================== */
(function () {
  "use strict";
  const THEME_KEY = "pm-tracker.theme";
  const S = { config: null, user: null, users: [], enquiries: [], counts: { open: 0, closed: 0 }, filter: { status: "open", q: "", quick: "" },
    notifications: [], unread: 0, sse: null, notesFor: null, filesFor: null, alertQueue: [] };

  // ---- tiny DOM helpers ----------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden") e[k] = !!attrs[k];
      else if (k === "value") e.value = attrs[k];
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function svg(path) { const w = el("span"); w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + path + '"/></svg>'; return w.firstChild; }
  const ICON_CLIP = "M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z";
  const ICON_NOTE = "M4 3h16a1 1 0 0 1 1 1v10.6l-6.4 6.4H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v14h8v-5h5V5H5zm2 3h10v2H7V8zm0 4h6v2H7v-2z";
  const ICON_PDF = "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5zM7.5 13h1.7c1.2 0 2 .7 2 1.8s-.8 1.8-2 1.8h-.6V18H7.5v-5zm1.1 1v1.6h.5c.6 0 .9-.3.9-.8s-.3-.8-.9-.8h-.5zm3.4-1h1.7c1.6 0 2.5 1 2.5 2.5S15.3 18 13.7 18H12v-5zm1.1 1v3h.6c.9 0 1.4-.5 1.4-1.5s-.5-1.5-1.4-1.5h-.6zm3.7-1h3v1h-1.9v1.1h1.7v1h-1.7V18h-1.1v-5z";

  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "Today " + time;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday " + time;
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) + " " + time;
  }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function initials(name) { return String(name || "").split(/\s+/).map(function (p) { return p[0]; }).join("").slice(0, 2).toUpperCase(); }
  function userName(id) { const u = S.users.find(function (x) { return x.id === id; }); return u ? u.name : ""; }
  function preferredLabel(p) { return { call: "Call", text: "Text", email: "Email" }[p] || "—"; }
  function isComplete(e) { return e.advisor.done && (!e.parts.quoteRequired || e.parts.done); }

  // ---- API -------------------------------------------------------------------
  async function api(method, path, body, raw) {
    const opts = { method: method, headers: { "X-Requested-With": "PrestonMazdaTracker" }, credentials: "same-origin" };
    if (body !== undefined) {
      if (raw) { opts.body = body; opts.headers["Content-Type"] = "application/pdf"; }
      else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && S.user) { S.user = null; stopLive(); navigate("/login"); }
    if (!res.ok) { const err = new Error(data.error || ("Request failed (" + res.status + ")")); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  // ---- toasts / popups -----------------------------------------------------
  function toast(msg, isError) {
    const t = el("div", { class: "toast" + (isError ? " toast--error" : ""), text: msg });
    $("#toasts").appendChild(t);
    setTimeout(function () { t.remove(); }, isError ? 6000 : 3500);
  }
  function showAlert(n) {
    const d = $("#alertDialog");
    if (d.open) { S.alertQueue.push(n); return; }
    $("#alertTitle").textContent = n.title;
    $("#alertBody").textContent = n.body;
    $("#alertMeta").textContent = fmtWhen(n.createdAt);
    const open = $("#alertOpen");
    open.hidden = !n.enquiryId;
    open.onclick = function () { d.close(); markRead([n.id]); navigate("/enquiry/" + n.enquiryId); };
    d.showModal();
    d.addEventListener("close", function next() { d.removeEventListener("close", next); const q = S.alertQueue.shift(); if (q) setTimeout(function () { showAlert(q); }, 150); });
    try { if ("Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(n.title, { body: n.body, icon: "/assets/favicon.svg" }); } catch (e) { /* ignore */ }
  }

  // ---- theme ------------------------------------------------------------------
  function applyTheme() {
    let t = null; try { t = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme();
  }

  // ---- routing -----------------------------------------------------------------
  function navigate(hash) { if (location.hash === "#" + hash) render(); else location.hash = hash; }
  function currentRoute() {
    const h = location.hash.replace(/^#/, "") || "/";
    const q = h.indexOf("?"); const pathPart = q >= 0 ? h.slice(0, q) : h;
    return { path: pathPart, params: new URLSearchParams(q >= 0 ? h.slice(q + 1) : "") };
  }
  window.addEventListener("hashchange", render);

  function render() {
    const r = currentRoute();
    const app = $("#app");
    const guest = ["/login", "/register", "/forgot", "/reset"];
    $("#topControls").hidden = !S.user;
    $("#topControlsGuest").hidden = !!S.user;
    if (!S.user) {
      if (!guest.includes(r.path)) { location.replace("#/login"); return; }
      clear(app);
      if (r.path === "/login") app.appendChild(viewLogin(r));
      if (r.path === "/register") app.appendChild(viewRegister());
      if (r.path === "/forgot") app.appendChild(viewForgot());
      if (r.path === "/reset") app.appendChild(viewReset(r.params.get("token") || ""));
      return;
    }
    if (guest.includes(r.path)) { location.replace("#/"); return; }
    if (r.path === "/users") { if (S.user.role !== "admin") { location.replace("#/"); return; } clear(app); app.appendChild(viewUsers()); loadUsers(); return; }
    const m = /^\/enquiry\/([^/]+)$/.exec(r.path);
    if (m) { renderBoard(); focusRow(m[1]); history.replaceState(null, "", "#/"); return; }
    renderBoard();
  }

  // ---- auth views --------------------------------------------------------------
  function banner(text, kind) { return el("div", { class: "auth__banner" + (kind ? " auth__banner--" + kind : ""), text: text }); }
  function viewLogin(r) {
    const status = el("p", { class: "dialog__status" });
    const form = el("form", { novalidate: "", onsubmit: async function (ev) {
      ev.preventDefault(); status.className = "dialog__status"; status.textContent = "Signing in…";
      try {
        const d = await api("POST", "/api/auth/login", { email: form.email.value, password: form.password.value });
        afterLogin(d.user);
      } catch (err) { status.className = "dialog__status is-error"; status.textContent = err.message; }
    } }, [
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Work email address" }), el("input", { type: "email", name: "email", autocomplete: "username", required: "", placeholder: "you@" + ((S.config && S.config.allowedDomains[0]) || "maxkirwan.com.au") })]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Password" }), el("input", { type: "password", name: "password", autocomplete: "current-password", required: "" })]),
      el("button", { class: "btn btn--primary", type: "submit", text: "Sign in" }),
      status
    ]);
    const card = el("section", { class: "card auth" }, [
      el("h2", { text: "Sign in" }),
      r.params.get("msg") ? banner(r.params.get("msg"), r.params.get("kind") || "") : null,
      form,
      el("p", { class: "help" }, ["Forgot your password? ", el("button", { class: "link", type: "button", text: "Reset it by email", onclick: function () { navigate("/forgot"); } })]),
      el("p", { class: "help" }, ["New here? ", el("button", { class: "link", type: "button", text: "Request an account", onclick: function () { navigate("/register"); } }), ". Accounts are approved by " + ((S.config && S.config.approverEmail) || "the service manager") + "."])
    ]);
    return card;
  }
  function viewRegister() {
    const status = el("p", { class: "dialog__status" });
    const form = el("form", { novalidate: "", onsubmit: async function (ev) {
      ev.preventDefault(); status.className = "dialog__status";
      if (form.password.value !== form.confirm.value) { status.className = "dialog__status is-error"; status.textContent = "Passwords do not match."; return; }
      status.textContent = "Creating your account…";
      try {
        const d = await api("POST", "/api/auth/register", { name: form.name.value, email: form.email.value, password: form.password.value, department: form.department.value });
        if (d.status === "active") afterLogin(d.user);
        else location.hash = "/login?kind=ok&msg=" + encodeURIComponent(d.message);
      } catch (err) { status.className = "dialog__status is-error"; status.textContent = err.message; }
    } }, [
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Your name" }), el("input", { type: "text", name: "name", autocomplete: "name", required: "", maxlength: "80" })]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Work email address" }), el("input", { type: "email", name: "email", autocomplete: "username", required: "", placeholder: "you@" + ((S.config && S.config.allowedDomains[0]) || "maxkirwan.com.au") })]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Department" }), el("select", { name: "department" }, [el("option", { value: "service", text: "Service advisor" }), el("option", { value: "parts", text: "Parts department" }), el("option", { value: "management", text: "Management" })])]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Password" }), el("input", { type: "password", name: "password", autocomplete: "new-password", required: "", minlength: "10" })]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Confirm password" }), el("input", { type: "password", name: "confirm", autocomplete: "new-password", required: "" })]),
      el("p", { class: "help", text: "At least 10 characters, with letters and numbers. Use your work email address – other addresses are not accepted." }),
      el("button", { class: "btn btn--primary", type: "submit", text: "Request account" }),
      status
    ]);
    return el("section", { class: "card auth" }, [
      el("h2", { text: "Request an account" }),
      banner("New accounts are approved by " + ((S.config && S.config.approverEmail) || "the service manager") + ". You will get an email once you can sign in."),
      form,
      el("p", { class: "help" }, ["Already have an account? ", el("button", { class: "link", type: "button", text: "Sign in", onclick: function () { navigate("/login"); } })])
    ]);
  }
  function viewForgot() {
    const status = el("p", { class: "dialog__status" });
    const form = el("form", { novalidate: "", onsubmit: async function (ev) {
      ev.preventDefault(); status.className = "dialog__status"; status.textContent = "Sending…";
      try { const d = await api("POST", "/api/auth/forgot", { email: form.email.value }); status.className = "dialog__status is-ok"; status.textContent = d.message; }
      catch (err) { status.className = "dialog__status is-error"; status.textContent = err.message; }
    } }, [
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Work email address" }), el("input", { type: "email", name: "email", autocomplete: "username", required: "" })]),
      el("button", { class: "btn btn--primary", type: "submit", text: "Email me a reset link" }),
      status
    ]);
    return el("section", { class: "card auth" }, [
      el("h2", { text: "Forgot your password?" }),
      el("p", { class: "help", text: "Enter your work email address and we will send you a link to choose a new password. The link works for one hour." }),
      form,
      el("p", { class: "help" }, [el("button", { class: "link", type: "button", text: "Back to sign in", onclick: function () { navigate("/login"); } })])
    ]);
  }
  function viewReset(token) {
    const status = el("p", { class: "dialog__status" });
    const form = el("form", { novalidate: "", onsubmit: async function (ev) {
      ev.preventDefault(); status.className = "dialog__status";
      if (form.password.value !== form.confirm.value) { status.className = "dialog__status is-error"; status.textContent = "Passwords do not match."; return; }
      status.textContent = "Saving…";
      try {
        const d = await api("POST", "/api/auth/reset", { token: token, password: form.password.value });
        if (d.user) { toast("Password saved. You are signed in."); afterLogin(d.user); }
        else location.hash = "/login?kind=ok&msg=" + encodeURIComponent(d.status === "pending" ? "Password saved. Your account is still waiting for approval." : "Password saved. You can sign in now.");
      } catch (err) { status.className = "dialog__status is-error"; status.textContent = err.message; }
    } }, [
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "New password" }), el("input", { type: "password", name: "password", autocomplete: "new-password", required: "", minlength: "10" })]),
      el("label", { class: "field" }, [el("span", { class: "field__label", text: "Confirm new password" }), el("input", { type: "password", name: "confirm", autocomplete: "new-password", required: "" })]),
      el("p", { class: "help", text: "At least 10 characters, with letters and numbers." }),
      el("button", { class: "btn btn--primary", type: "submit", text: "Save password" }),
      status
    ]);
    return el("section", { class: "card auth" }, [
      el("h2", { text: "Choose a password" }),
      token ? form : banner("This link is missing its code. Please use the link from your email.", "bad"),
      el("p", { class: "help" }, [el("button", { class: "link", type: "button", text: "Back to sign in", onclick: function () { navigate("/login"); } })])
    ]);
  }

  async function afterLogin(user) {
    S.user = user;
    $("#userName").textContent = user.name;
    $("#userAvatar").textContent = initials(user.name);
    $("#userEmail").textContent = user.email + " · " + user.department;
    $("#menuUsers").hidden = user.role !== "admin";
    await Promise.all([loadUsers(), loadEnquiries(), loadNotifications()]);
    startLive();
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) { /* ignore */ }
    const r = currentRoute();
    if (["/login", "/register", "/forgot", "/reset"].includes(r.path)) location.hash = "/"; else render();
  }
  async function logout() {
    try { await api("POST", "/api/auth/logout", {}); } catch (e) { /* ignore */ }
    S.user = null; stopLive(); location.hash = "/login";
    render();
  }

  // ---- data loading ----------------------------------------------------------
  async function loadUsers() {
    if (!S.user) return;
    const d = await api("GET", "/api/users");
    S.users = d.users; S.mail = d.mail || null;
    if (currentRoute().path === "/users") { const v = $("#usersView"); if (v) fillUsers(v); }
    if (currentRoute().path === "/") fillSheet();
  }
  async function loadEnquiries() {
    if (!S.user) return;
    const d = await api("GET", "/api/enquiries?status=" + encodeURIComponent(S.filter.status));
    S.enquiries = d.enquiries; S.counts = d.counts;
    if (currentRoute().path === "/" || currentRoute().path.startsWith("/enquiry/")) renderBoard();
    if (S.notesFor) { const e = S.enquiries.find(function (x) { return x.id === S.notesFor; }); if (e) fillNotes(e); }
    if (S.filesFor) { const e = S.enquiries.find(function (x) { return x.id === S.filesFor; }); if (e) fillFiles(e); }
  }
  async function loadNotifications() {
    if (!S.user) return;
    const d = await api("GET", "/api/notifications");
    S.notifications = d.notifications; S.unread = d.unread; updateBadge();
    if ($("#notifDialog").open) fillNotifs();
  }
  function updateBadge() { const b = $("#bellBadge"); b.hidden = !S.unread; b.textContent = S.unread > 99 ? "99+" : String(S.unread); document.title = (S.unread ? "(" + S.unread + ") " : "") + "Preston Mazda Enquiry Tracker"; }
  async function markRead(ids) { try { const d = await api("POST", "/api/notifications/read", { ids: ids || null }); S.unread = d.unread; S.notifications.forEach(function (n) { if (!ids || ids.includes(n.id)) n.readAt = n.readAt || new Date().toISOString(); }); updateBadge(); } catch (e) { /* ignore */ } }

  // ---- live updates (SSE) ------------------------------------------------------
  let refreshTimer = null;
  function startLive() {
    stopLive();
    const es = new EventSource("/api/events");
    S.sse = es;
    es.addEventListener("hello", function () { setLive(true); });
    es.addEventListener("enquiries", function (ev) {
      let d = {}; try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
      clearTimeout(refreshTimer); refreshTimer = setTimeout(loadEnquiries, 150);
      if (d.by && d.by !== S.user.name && d.action === "created") toast(d.by + " logged a new enquiry");
    });
    es.addEventListener("users", function () { loadUsers(); });
    es.addEventListener("notification", function (ev) {
      let n = null; try { n = JSON.parse(ev.data); } catch (e) { return; }
      S.notifications.unshift(n); S.unread++; updateBadge();
      if ($("#notifDialog").open) fillNotifs();
      showAlert(n);
    });
    es.onerror = function () { setLive(false); };
    es.onopen = function () { setLive(true); loadEnquiries(); loadNotifications(); };
  }
  function stopLive() { if (S.sse) { S.sse.close(); S.sse = null; } setLive(false); }
  function setLive(on) { const s = $("#liveStatus"); s.className = "live " + (on ? "live--on" : "live--off"); s.textContent = on ? "● Live" : "● Reconnecting…"; if (!S.user) s.textContent = "● Offline"; }

  // ---- sheet (spreadsheet-style enquiry log) ----------------------------------------
  // Every enquiry is a row; every field is a cell you type straight into. Changes save
  // on the spot. Draft rows live in the browser until a customer name is entered.
  S.drafts = [];
  S.sort = { key: "ref", dir: 1 };

  const COLS = [
    { group: "", key: "ref", label: "#", cls: "c-ref", sort: "ref" },
    { group: "Customer", key: "customer.name", label: "Name", cls: "c-name", type: "text", sort: "name", placeholder: "Customer name" },
    { group: "Customer", key: "customer.registration", label: "Registration", cls: "c-rego", type: "text", sort: "registration", upper: true, placeholder: "ABC123" },
    { group: "Customer", key: "customer.phone", label: "Contact number", cls: "c-phone", type: "tel", sort: "phone" },
    { group: "Customer", key: "customer.email", label: "Email address", cls: "c-email", type: "email", sort: "email" },
    { group: "Customer", key: "customer.preferred", label: "Preferred method", cls: "c-pref", type: "select", options: [["call", "Call"], ["text", "Text"], ["email", "Email"]], sort: "preferred" },
    { group: "Customer", key: "enquiry", label: "Enquiry", cls: "c-enq", type: "text", placeholder: "What they are asking about" },
    { group: "", key: "attachments", label: "📎", title: "Parts quotes (PDF)", cls: "c-icon" },
    { group: "", key: "notes", label: "🗒", title: "Notes", cls: "c-icon" },
    { group: "Service advisor", key: "advisor.userId", label: "Allocated to", cls: "c-user", type: "user", dept: "service", sort: "advisor" },
    { group: "Service advisor", key: "advisor.contactRequired", label: "Contact customer", cls: "c-check", type: "check", title: "Emails " + "advisors@" },
    { group: "Service advisor", key: "advisor.done", label: "Done", cls: "c-check c-done", type: "check" },
    { group: "Parts department", key: "parts.userId", label: "Allocated to", cls: "c-user", type: "user", dept: "parts", sort: "parts" },
    { group: "Parts department", key: "parts.quoteRequired", label: "Quote required", cls: "c-check", type: "check", title: "Emails parts@" },
    { group: "Parts department", key: "parts.done", label: "Done", cls: "c-check c-done", type: "check" },
    { group: "", key: "status", label: "Status", cls: "c-status", type: "select", options: [["open", "Open"], ["closed", "Closed"]], sort: "status" },
    { group: "", key: "logged", label: "Logged", cls: "c-logged", sort: "createdAt" },
    { group: "", key: "actions", label: "", cls: "c-actions" }
  ];

  function getPath(obj, key) { return key.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
  function setPath(obj, key, val) { const ks = key.split("."); let o = obj; ks.slice(0, -1).forEach(function (k) { o = o[k] = o[k] || {}; }); o[ks[ks.length - 1]] = val; }
  function bodyFor(e, key, val) {
    const body = {};
    if (key.indexOf("customer.") === 0) { body.customer = {}; body.customer[key.slice(9)] = val; }
    else if (key.indexOf(".") > 0) { const p = key.split("."); body[p[0]] = {}; body[p[0]][p[1]] = val; }
    else body[key] = val;
    return body;
  }
  function newDraft() {
    return { id: "draft_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), draft: true, ref: "new", customer: { name: "", registration: "", phone: "", email: "", preferred: "call" }, enquiry: "",
      advisor: { userId: S.user.department === "service" ? S.user.id : null, contactRequired: false, done: false }, parts: { userId: null, quoteRequired: false, done: false },
      status: "open", attachments: [], notes: [], createdAt: null };
  }
  function sortValue(e, key) {
    switch (key) {
      case "ref": return e.draft ? "~" : e.ref;
      case "name": return (e.customer.name || "").toLowerCase();
      case "registration": return e.customer.registration || "";
      case "phone": return e.customer.phone || "";
      case "email": return e.customer.email || "";
      case "preferred": return e.customer.preferred || "";
      case "advisor": return userName(e.advisor.userId).toLowerCase();
      case "parts": return userName(e.parts.userId).toLowerCase();
      case "status": return e.status;
      case "createdAt": return e.createdAt || "~";
      default: return "";
    }
  }
  function visibleRows() {
    let list = S.enquiries.filter(function (e) { return matches(e, S.filter.q); });
    const dir = S.sort.dir, key = S.sort.key;
    list.sort(function (a, b) { const x = sortValue(a, key), y = sortValue(b, key); return x < y ? -dir : x > y ? dir : 0; });
    return list.concat(S.drafts);
  }
  function matches(e, q) {
    if (!q) return true;
    const hay = [e.ref, e.customer.name, e.customer.registration, e.customer.phone, e.customer.email, e.enquiry, userName(e.advisor.userId), userName(e.parts.userId)].concat(e.notes.map(function (n) { return n.text; })).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.includes(w); });
  }

  function renderBoard() {
    const app = $("#app");
    let view = $("#sheetView");
    if (!view) {
      clear(app);
      view = el("div", { id: "sheetView" });
      const toolbar = el("div", { class: "toolbar" }, [
        el("button", { class: "btn btn--primary", type: "button", id: "btnAddRow", text: "+ New row", onclick: addRow }),
        el("input", { class: "search", type: "search", id: "search", placeholder: "Search name, rego, phone, email, enquiry, notes…", value: S.filter.q, oninput: function (ev) { S.filter.q = ev.target.value; fillSheet(); } }),
        el("div", { class: "seg", id: "statusSeg" }, ["open", "closed", "all"].map(function (s) {
          return el("button", { type: "button", "data-status": s, class: S.filter.status === s ? "is-active" : "", text: s === "open" ? "Open" : s === "closed" ? "Closed" : "All", onclick: function () { setStatusFilter(s); } });
        })),
        el("span", { class: "toolbar__meta", id: "sheetMeta" }),
        el("button", { class: "btn", type: "button", text: "Export CSV", onclick: exportCsv })
      ]);
      const thead = el("thead", null, [
        el("tr", { class: "groups" }, groupHeaders()),
        el("tr", null, COLS.map(function (c) {
          const th = el("th", { scope: "col", class: c.cls + (c.sort ? " sortable" : ""), title: c.title || null, text: c.label });
          if (c.sort) th.addEventListener("click", function () { if (S.sort.key === c.sort) S.sort.dir = -S.sort.dir; else S.sort = { key: c.sort, dir: 1 }; fillSheet(); });
          return th;
        }))
      ]);
      const table = el("table", { class: "sheet", id: "sheet" }, [thead, el("tbody", { id: "sheetBody" })]);
      const wrap = el("div", { class: "sheet-wrap", id: "sheetWrap" }, [table]);
      view.appendChild(toolbar);
      view.appendChild(wrap);
      view.appendChild(el("p", { class: "help sheet-help", text: "Type straight into the cells – changes save as you go. Enter or the arrow keys move up and down a column, Tab moves across. Ticking “Contact customer” emails " + S.config.advisorsEmail + "; ticking “Quote required” emails " + S.config.partsEmail + ". Allocating a row emails and pops up for that person." }));
      app.appendChild(view);
    }
    fillSheet();
  }
  function groupHeaders() {
    const out = []; let i = 0;
    while (i < COLS.length) {
      const g = COLS[i].group; let span = 1;
      while (i + span < COLS.length && COLS[i + span].group === g && g) span++;
      out.push(el("th", { colspan: String(span), class: g ? "group" : "group group--blank", text: g }));
      i += span;
    }
    return out;
  }
  function setStatusFilter(s) {
    S.filter.status = s;
    $$("#statusSeg button").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-status") === s); });
    loadEnquiries();
  }
  function keepFocus() {
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest("#sheetWrap") || !a.getAttribute("data-field")) return null;
    const tr = a.closest("tr");
    return { id: tr.getAttribute("data-id"), field: a.getAttribute("data-field"), text: a.tagName === "INPUT" && a.type !== "checkbox", value: a.value, s: a.selectionStart, e: a.selectionEnd };
  }
  function restoreFocus(k, newId) {
    if (!k) return;
    const t = $('#sheetBody tr[data-id="' + (newId || k.id) + '"] [data-field="' + k.field + '"]');
    if (!t) return;
    if (k.text) { t.value = k.value; }
    t.focus();
    if (k.text && k.s != null) { try { t.setSelectionRange(k.s, k.e); } catch (e) { /* ignore */ } }
  }
  function fillSheet() {
    const body = $("#sheetBody"); if (!body) return;
    const keep = keepFocus();
    $$("tr", body).forEach(function (tr) { tr._replacing = true; });
    clear(body);
    const rows = visibleRows();
    $$("#sheet thead th.sortable").forEach(function (th) { th.classList.remove("is-sorted", "asc"); });
    const sortedCol = COLS.find(function (c) { return c.sort === S.sort.key; });
    if (sortedCol) { const th = $$("#sheet thead tr:last-child th")[COLS.indexOf(sortedCol)]; th.classList.add("is-sorted"); if (S.sort.dir < 0) th.classList.add("asc"); }
    $("#sheetMeta").textContent = (rows.length - S.drafts.length) + " row" + (rows.length - S.drafts.length === 1 ? "" : "s") + " · " + S.counts.open + " open, " + S.counts.closed + " closed";
    if (!rows.length) { body.appendChild(el("tr", { class: "empty-row" }, [el("td", { colspan: String(COLS.length), class: "empty", text: S.enquiries.length ? "Nothing matches that search." : "No enquiries yet. Click “+ New row” and start typing." })])); return; }
    rows.forEach(function (e, i) { body.appendChild(rowFor(e, i + 1)); });
    restoreFocus(keep);
  }
  function refreshRow(e) {
    const old = $('#sheetBody tr[data-id="' + e.id + '"]');
    if (!old) { fillSheet(); return; }
    const keep = keepFocus();
    const n = old.querySelector(".rownum") ? old.querySelector(".rownum").textContent : "";
    old._replacing = true;
    old.replaceWith(rowFor(e, n));
    if (keep && keep.id === e.id) restoreFocus(keep);
  }

  function cellFor(e, c, rowIndex) {
    const td = el("td", { class: c.cls });
    const val = getPath(e, c.key);
    switch (c.type) {
      case "text": case "tel": case "email": {
        const inp = el("input", { type: c.type, value: val || "", placeholder: c.placeholder || "", "aria-label": c.label, class: c.upper ? "upper" : null, "data-field": c.key, autocomplete: "off", spellcheck: "false" });
        const save = function () { const tr = inp.closest("tr"); if (!inp.isConnected || (tr && tr._replacing)) return; const v = c.upper ? inp.value.toUpperCase().trim() : inp.value.trim(); if (v !== (getPath(e, c.key) || "")) commit(e, c.key, v); };
        inp.addEventListener("blur", save);
        inp.addEventListener("keydown", cellKeys);
        inp._save = save;
        td.appendChild(inp);
        return td;
      }
      case "select": {
        const sel = el("select", { "aria-label": c.label, "data-field": c.key }, c.options.map(function (o) { return el("option", { value: o[0], text: o[1], selected: val === o[0] }); }));
        sel.addEventListener("change", function () { commit(e, c.key, sel.value); });
        sel.addEventListener("keydown", cellKeys);
        td.appendChild(sel);
        return td;
      }
      case "user": {
        const sel = el("select", { "aria-label": c.label, "data-field": c.key }, userOptions(c.dept, val));
        sel.addEventListener("change", function () { commit(e, c.key, sel.value || null); });
        sel.addEventListener("keydown", cellKeys);
        td.appendChild(sel);
        return td;
      }
      case "check": {
        const doneBy = c.key.endsWith(".done") && val ? getPath(e, c.key.replace(".done", ".doneByName")) : null;
        const cb = el("input", { type: "checkbox", checked: !!val, "aria-label": c.label, "data-field": c.key, title: doneBy ? "Done by " + doneBy + " · " + fmtWhen(getPath(e, c.key.replace(".done", ".doneAt"))) : (c.title || null) });
        cb.addEventListener("change", function () { commit(e, c.key, cb.checked); });
        cb.addEventListener("keydown", cellKeys);
        if (val) td.classList.add("is-on");
        td.appendChild(el("label", { class: "cellcheck" }, [cb, doneBy ? el("span", { class: "doneby", text: doneBy.split(" ")[0] }) : null]));
        return td;
      }
    }
    switch (c.key) {
      case "ref": td.appendChild(el("span", { class: "rownum", text: String(rowIndex) })); td.appendChild(el("span", { class: "ref", text: e.draft ? "new" : e.ref })); td.title = e.draft ? "Not saved yet – enter a name" : e.ref; return td;
      case "attachments": td.appendChild(el("button", { class: "iconbtn iconbtn--file" + (e.attachments.length ? " has-items" : ""), type: "button", disabled: !!e.draft, title: "Parts quotes (PDF)", "aria-label": "Attachments for " + (e.customer.name || "row"), onclick: function () { openFiles(e); } }, [svg(ICON_CLIP), e.attachments.length ? el("span", { class: "count", text: String(e.attachments.length) }) : null])); return td;
      case "notes": td.appendChild(el("button", { class: "iconbtn iconbtn--note" + (e.notes.length ? " has-items" : ""), type: "button", disabled: !!e.draft, title: "Notes", "aria-label": "Notes for " + (e.customer.name || "row"), onclick: function () { openNotes(e); } }, [svg(ICON_NOTE), e.notes.length ? el("span", { class: "count", text: String(e.notes.length) }) : null])); return td;
      case "logged": td.appendChild(el("span", { class: "logged", text: e.draft ? "Unsaved" : fmtWhen(e.createdAt) })); if (!e.draft) td.appendChild(el("span", { class: "logged__by", text: e.createdByName || "" })); td.title = e.draft ? "" : "Last change " + fmtWhen(e.updatedAt) + (e.updatedByName ? " by " + e.updatedByName : ""); return td;
      case "actions": {
        const canDelete = e.draft || S.user.role === "admin" || e.createdBy === S.user.id;
        if (canDelete) td.appendChild(el("button", { class: "rowdel", type: "button", title: e.draft ? "Discard row" : "Delete row", "aria-label": "Delete row", text: "✕", onclick: function () { deleteRow(e); } }));
        return td;
      }
    }
    return td;
  }
  function rowFor(e, rowIndex) {
    const complete = !e.draft && e.advisor.done && (!e.parts.quoteRequired || e.parts.done);
    const tr = el("tr", { "data-id": e.id, class: (e.draft ? "is-draft " : "") + (e.status === "closed" ? "is-closed " : "") + (complete && e.status === "open" ? "is-complete" : "") });
    COLS.forEach(function (c) { tr.appendChild(cellFor(e, c, rowIndex)); });
    return tr;
  }
  function cellKeys(ev) {
    const inp = ev.target;
    if (inp.tagName === "SELECT" && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) return; // let selects change value
    let dir = 0;
    if (ev.key === "Enter") dir = ev.shiftKey ? -1 : 1;
    else if (ev.key === "ArrowDown") dir = 1;
    else if (ev.key === "ArrowUp") dir = -1;
    else if (ev.key === "Escape") { inp.blur(); return; }
    if (!dir) return;
    ev.preventDefault();
    const tr = inp.closest("tr");
    const next = dir > 0 ? tr.nextElementSibling : tr.previousElementSibling;
    if (ev.key === "Enter" && inp._save) inp._save();
    if (!next) { if (dir > 0 && ev.key === "Enter" && !tr.classList.contains("is-draft")) { addRow(inp.getAttribute("data-field")); } else inp.blur(); return; }
    const target = next.querySelector('[data-field="' + inp.getAttribute("data-field") + '"]');
    if (target) { target.focus(); if (target.select && target.type !== "checkbox") target.select(); }
  }

  async function commit(e, key, val) {
    if (e.draft) {
      setPath(e, key, val);
      if (!e.customer.name.trim() || e.saving) return;
      // Enough to save: create it on the server, then swap the draft for the real row.
      e.saving = true;
      const body = JSON.parse(JSON.stringify({ customer: e.customer, enquiry: e.enquiry, advisor: e.advisor, parts: e.parts }));
      try {
        const d = await api("POST", "/api/enquiries", body);
        // Anything typed into the other cells while the save was in flight goes on as a follow-up.
        const extra = {};
        Object.keys(e.customer).forEach(function (k) { if (e.customer[k] !== body.customer[k]) { extra.customer = extra.customer || {}; extra.customer[k] = e.customer[k]; } });
        if (e.enquiry !== body.enquiry) extra.enquiry = e.enquiry;
        ["advisor", "parts"].forEach(function (g) { Object.keys(e[g]).forEach(function (k) { if (e[g][k] !== body[g][k]) { extra[g] = extra[g] || {}; extra[g][k] = e[g][k]; } }); });
        let enq = d.enquiry;
        if (Object.keys(extra).length) { try { enq = (await api("PATCH", "/api/enquiries/" + encodeURIComponent(enq.id), extra)).enquiry; } catch (err2) { toast(err2.message, true); } }
        S.drafts = S.drafts.filter(function (x) { return x !== e; });
        S.enquiries.push(enq); S.counts.open++;
        const keep = keepFocus();
        const old = $('#sheetBody tr[data-id="' + e.id + '"]');
        const fresh = rowFor(enq, old && old.querySelector(".rownum") ? old.querySelector(".rownum").textContent : "");
        if (old) { old._replacing = true; old.replaceWith(fresh); } else fillSheet();
        if (keep && keep.id === e.id) restoreFocus(keep, enq.id);
        $("#sheetMeta").textContent = S.enquiries.length + " rows · " + S.counts.open + " open, " + S.counts.closed + " closed";
        toast("Saved " + enq.ref + " – " + enq.customer.name);
      } catch (err) { e.saving = false; toast(err.message, true); }
      return;
    }
    const before = JSON.stringify(e);
    setPath(e, key, val); // optimistic – later edits compare against the value we just sent
    try {
      const d = await api("PATCH", "/api/enquiries/" + encodeURIComponent(e.id), bodyFor(e, key, val));
      Object.assign(e, d.enquiry);
      if (key === "status") { S.counts = { open: S.enquiries.filter(function (x) { return x.status === "open"; }).length, closed: S.counts.open + S.counts.closed - S.enquiries.filter(function (x) { return x.status === "open"; }).length }; if (S.filter.status !== "all" && e.status !== S.filter.status) { toast(e.ref + " moved to " + (e.status === "closed" ? "Closed" : "Open")); loadEnquiries(); return; } }
      if (key === "advisor.contactRequired" && val) toast("Alert emailed to " + S.config.advisorsEmail);
      if (key === "parts.quoteRequired" && val) toast("Alert emailed to " + S.config.partsEmail);
      refreshRow(e);
    } catch (err) {
      toast(err.message, true);
      Object.assign(e, JSON.parse(before));
      refreshRow(e);
    }
  }
  function addRow(focusField) {
    const d = newDraft();
    S.drafts.push(d);
    const body = $("#sheetBody");
    const emptyRow = body.querySelector(".empty-row"); if (emptyRow) emptyRow.remove();
    const tr = rowFor(d, body.children.length + 1);
    body.appendChild(tr);
    const t = tr.querySelector('[data-field="' + (focusField || "customer.name") + '"]') || tr.querySelector('[data-field="customer.name"]');
    if (t) { t.focus(); t.scrollIntoView({ block: "nearest" }); }
  }
  async function deleteRow(e) {
    if (e.draft) { S.drafts = S.drafts.filter(function (x) { return x !== e; }); fillSheet(); return; }
    if (!confirm("Delete row " + e.ref + " (" + e.customer.name + ")? Notes and attachments will be removed too.")) return;
    try { await api("DELETE", "/api/enquiries/" + encodeURIComponent(e.id)); toast("Deleted " + e.ref); loadEnquiries(); } catch (err) { toast(err.message, true); }
  }
  function userOptions(department, selectedId) {
    const opts = [el("option", { value: "", text: "—" })];
    S.users.filter(function (u) { return u.status === "active" && (u.department === department || u.role === "admin" || u.id === selectedId); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (u) { opts.push(el("option", { value: u.id, text: u.name + (u.department !== department ? " (" + u.department + ")" : ""), selected: u.id === selectedId })); });
    if (selectedId && !S.users.some(function (u) { return u.id === selectedId; })) opts.push(el("option", { value: selectedId, text: "(former user)", selected: true }));
    return opts;
  }
  async function focusRow(id) {
    let e = S.enquiries.find(function (x) { return x.id === id; });
    if (!e) {
      try { const d = await api("GET", "/api/enquiries/" + encodeURIComponent(id)); if (d.enquiry.status !== S.filter.status && S.filter.status !== "all") { S.filter.status = "all"; $$("#statusSeg button").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-status") === "all"); }); await loadEnquiries(); } }
      catch (err) { toast("That enquiry no longer exists.", true); return; }
      e = S.enquiries.find(function (x) { return x.id === id; });
      if (!e) return;
    }
    const tr = $('#sheetBody tr[data-id="' + id + '"]');
    if (!tr) return;
    tr.scrollIntoView({ block: "center" });
    tr.classList.add("is-highlight");
    setTimeout(function () { tr.classList.remove("is-highlight"); }, 2500);
    const t = tr.querySelector('[data-field="customer.name"]'); if (t) t.focus();
  }
  function exportCsv() {
    const rows = visibleRows().filter(function (e) { return !e.draft; });
    const head = ["Ref", "Logged", "Logged by", "Name", "Registration", "Contact number", "Email address", "Preferred method", "Enquiry", "Service advisor", "Contact customer", "Advisor done", "Parts allocated to", "Quote required", "Parts done", "Status", "Attachments", "Notes"];
    const q = function (v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [head.join(",")].concat(rows.map(function (e) {
      return [e.ref, e.createdAt ? new Date(e.createdAt).toLocaleString("en-AU") : "", e.createdByName, e.customer.name, e.customer.registration, e.customer.phone, e.customer.email, preferredLabel(e.customer.preferred), e.enquiry,
        userName(e.advisor.userId), e.advisor.contactRequired ? "Yes" : "", e.advisor.done ? "Yes" : "", userName(e.parts.userId), e.parts.quoteRequired ? "Yes" : "", e.parts.done ? "Yes" : "", e.status,
        e.attachments.map(function (a) { return a.name; }).join("; "), e.notes.map(function (n) { return fmtWhen(n.createdAt) + " " + n.spokeWith + ": " + n.text; }).join(" | ")].map(q).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "enquiries-" + new Date().toISOString().slice(0, 10) + ".csv" });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- notes dialog ------------------------------------------------------------------
  function openNotes(e) {
    S.notesFor = e.id;
    const f = $("#noteForm"); f.reset(); f.spokeWith.value = S.user.name; $("#noteStatus").textContent = "";
    fillNotes(e);
    $("#notesDialog").showModal();
    f.text.focus();
  }
  function fillNotes(e) {
    $("#notesTitle").textContent = "Notes · " + e.customer.name + (e.customer.registration ? " · " + e.customer.registration : "");
    $("#notesMeta").textContent = e.ref + " · " + e.notes.length + (e.notes.length === 1 ? " note" : " notes");
    const list = clear($("#notesList"));
    if (!e.notes.length) list.appendChild(el("p", { class: "empty", text: "No notes yet. Record what was discussed and who spoke to the customer." }));
    e.notes.slice().reverse().forEach(function (n) {
      const canDel = S.user.role === "admin" || n.authorId === S.user.id;
      list.appendChild(el("div", { class: "note" }, [
        el("div", { class: "note__text", text: n.text }),
        el("div", { class: "note__meta" }, [
          el("span", null, [el("strong", { text: n.spokeWith }), " spoke to the customer · logged by " + n.authorName]),
          el("span", null, [fmtWhen(n.createdAt), canDel ? el("button", { class: "note__del", type: "button", title: "Delete note", "aria-label": "Delete note", text: "✕", onclick: async function () {
            if (!confirm("Delete this note?")) return;
            try { const d = await api("DELETE", "/api/enquiries/" + encodeURIComponent(e.id) + "/notes/" + encodeURIComponent(n.id)); Object.assign(e, d.enquiry); fillNotes(e); refreshRow(e); } catch (err) { toast(err.message, true); }
          } }) : null])
        ])
      ]));
    });
  }
  $("#noteForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const f = ev.target, st = $("#noteStatus");
    const e = S.enquiries.find(function (x) { return x.id === S.notesFor; });
    if (!e) return;
    if (!f.text.value.trim()) { st.className = "dialog__status is-error"; st.textContent = "Please write something in the note."; return; }
    st.className = "dialog__status"; st.textContent = "Saving…";
    try {
      const d = await api("POST", "/api/enquiries/" + encodeURIComponent(e.id) + "/notes", { text: f.text.value, spokeWith: f.spokeWith.value });
      Object.assign(e, d.enquiry); f.text.value = ""; st.textContent = ""; fillNotes(e); refreshRow(e);
    } catch (err) { st.className = "dialog__status is-error"; st.textContent = err.message; }
  });
  $("#notesDialog").addEventListener("close", function () { S.notesFor = null; });

  // ---- attachments dialog --------------------------------------------------------------
  function fileHint() { return "PDF only, up to " + ((S.config && S.config.maxUploadMb) || 15) + " MB each."; }
  function openFiles(e) {
    S.filesFor = e.id; $("#fileStatus").textContent = fileHint();
    fillFiles(e);
    $("#filesDialog").showModal();
  }
  function fillFiles(e) {
    $("#filesTitle").textContent = "Parts quotes · " + e.customer.name + (e.customer.registration ? " · " + e.customer.registration : "");
    $("#filesMeta").textContent = e.ref + " · " + e.attachments.length + (e.attachments.length === 1 ? " attachment" : " attachments");
    const list = clear($("#filesList"));
    if (!e.attachments.length) list.appendChild(el("p", { class: "empty", text: "No quotes attached yet." }));
    e.attachments.forEach(function (a) {
      const base = "/api/enquiries/" + encodeURIComponent(e.id) + "/attachments/" + encodeURIComponent(a.id);
      const canDel = S.user.role === "admin" || a.uploadedBy === S.user.id;
      list.appendChild(el("div", { class: "file" }, [
        el("span", { class: "file__icon" }, [svg(ICON_PDF)]),
        el("div", { class: "file__name" }, [el("a", { href: base, target: "_blank", rel: "noopener", text: a.name }), el("div", { class: "file__meta", text: fmtSize(a.size) + " · " + a.uploadedByName + " · " + fmtWhen(a.uploadedAt) })]),
        el("a", { class: "btn btn--small", href: base + "?download=1", text: "Download" }),
        canDel ? el("button", { class: "btn btn--small btn--danger", type: "button", text: "Remove", onclick: async function () {
          if (!confirm("Remove " + a.name + "?")) return;
          try { const d = await api("DELETE", base); Object.assign(e, d.enquiry); fillFiles(e); refreshRow(e); } catch (err) { toast(err.message, true); }
        } }) : null
      ]));
    });
  }
  async function uploadFiles(files) {
    const e = S.enquiries.find(function (x) { return x.id === S.filesFor; });
    if (!e || !files.length) return;
    const zone = $("#dropzone"), st = $("#fileStatus");
    zone.classList.add("is-busy");
    for (const file of Array.from(files)) {
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { toast(file.name + " is not a PDF", true); continue; }
      st.textContent = "Uploading " + file.name + "…";
      try {
        const d = await api("POST", "/api/enquiries/" + encodeURIComponent(e.id) + "/attachments?filename=" + encodeURIComponent(file.name), file, true);
        Object.assign(e, d.enquiry); fillFiles(e); refreshRow(e); toast("Attached " + file.name);
      } catch (err) { toast(err.message, true); }
    }
    st.textContent = fileHint();
    zone.classList.remove("is-busy");
    $("#fileInput").value = "";
  }
  $("#fileInput").addEventListener("change", function (ev) { uploadFiles(ev.target.files); });
  (function () {
    const z = $("#dropzone");
    z.addEventListener("dragover", function (ev) { ev.preventDefault(); z.classList.add("is-over"); });
    z.addEventListener("dragleave", function () { z.classList.remove("is-over"); });
    z.addEventListener("drop", function (ev) { ev.preventDefault(); z.classList.remove("is-over"); uploadFiles(ev.dataTransfer.files); });
  })();
  $("#filesDialog").addEventListener("close", function () { S.filesFor = null; });

  // ---- notifications dialog ----------------------------------------------------------------
  function fillNotifs() {
    const list = clear($("#notifList"));
    if (!S.notifications.length) { list.appendChild(el("p", { class: "empty", text: "No notifications yet." })); return; }
    S.notifications.forEach(function (n) {
      list.appendChild(el("div", { class: "notif" + (n.readAt ? "" : " is-unread"), role: "button", tabindex: "0", onclick: function () {
        if (!n.readAt) markRead([n.id]); n.readAt = n.readAt || new Date().toISOString();
        $("#notifDialog").close();
        if (n.enquiryId) navigate("/enquiry/" + n.enquiryId); else if (n.type === "approval") navigate("/users");
      } }, [el("div", { class: "notif__title", text: n.title }), el("div", { class: "notif__body", text: n.body }), el("div", { class: "notif__when", text: fmtWhen(n.createdAt) })]));
    });
  }
  $("#btnBell").addEventListener("click", function () { fillNotifs(); $("#notifDialog").showModal(); });
  $("#btnReadAll").addEventListener("click", function () { markRead(null).then(fillNotifs); });

  // ---- users page (admin) -------------------------------------------------------------------
  function viewUsers() {
    const v = el("div", { id: "usersView" }, [
      el("section", { class: "section" }, [
        el("div", { class: "section__head" }, [el("h2", { class: "section__title", text: "Waiting for approval" }), el("p", { class: "section__meta", text: "New accounts need approval by " + S.config.approverEmail + " before they can sign in." })]),
        el("div", { id: "pendingList", class: "tiles" })
      ]),
      el("section", { class: "section" }, [
        el("div", { class: "section__head" }, [el("h2", { class: "section__title", text: "Users" }), el("div", { class: "btn-row" }, [el("button", { class: "btn btn--primary", type: "button", text: "+ Add user", onclick: function () { $("#userForm").reset(); $("#userStatus").textContent = ""; $("#userDialog").showModal(); } })])]),
        el("div", { class: "card card--table" }, [el("div", { class: "table-wrap" }, [el("table", { class: "board users" }, [
          el("thead", null, [el("tr", null, ["Name", "Email", "Department", "Role", "Status", "Last sign-in", ""].map(function (h) { return el("th", { scope: "col", text: h }); }))]),
          el("tbody", { id: "usersBody" })
        ])])])
      ]),
      el("section", { class: "section" }, [
        el("div", { class: "section__head" }, [el("h2", { class: "section__title", text: "Email alerts" })]),
        el("div", { class: "card mailstatus", id: "mailStatus" })
      ])
    ]);
    return v;
  }
  function fillUsers(v) {
    const pending = S.users.filter(function (u) { return u.status === "pending"; });
    const pl = clear($("#pendingList", v));
    if (!pending.length) pl.appendChild(el("div", { class: "tile" }, [el("div", { class: "tile__label", text: "No requests waiting" }), el("div", { class: "tile__sub", text: "New requests appear here and by email." })]));
    pending.forEach(function (u) {
      pl.appendChild(el("div", { class: "tile tile--status-warn" }, [
        el("div", { class: "tile__label", text: "Requested " + fmtWhen(u.createdAt) }),
        el("div", { class: "tile__value", text: u.name }),
        el("div", { class: "tile__sub", text: u.email + " · " + u.department }),
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn btn--primary btn--small", type: "button", text: "Approve", onclick: function () { userPatch(u, { status: "active" }, "Approved " + u.name); } }),
          el("button", { class: "btn btn--small btn--danger", type: "button", text: "Decline", onclick: async function () { if (!confirm("Decline and remove the request from " + u.name + "?")) return; try { await api("DELETE", "/api/users/" + u.id); toast("Declined"); loadUsers(); } catch (err) { toast(err.message, true); } } })
        ])
      ]));
    });
    const body = clear($("#usersBody", v));
    S.users.filter(function (u) { return u.status !== "pending"; }).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (u) {
      const me = u.id === S.user.id;
      body.appendChild(el("tr", null, [
        el("td", { class: "name", text: u.name + (me ? " (you)" : "") }),
        el("td", { text: u.email }),
        el("td", null, [el("select", { onchange: function (ev) { userPatch(u, { department: ev.target.value }); } }, [["service", "Service advisor"], ["parts", "Parts department"], ["management", "Management"]].map(function (o) { return el("option", { value: o[0], text: o[1], selected: u.department === o[0] }); }))]),
        el("td", null, [el("select", { disabled: me, onchange: function (ev) { userPatch(u, { role: ev.target.value }); } }, [["staff", "Staff"], ["admin", "Administrator"]].map(function (o) { return el("option", { value: o[0], text: o[1], selected: u.role === o[0] }); }))]),
        el("td", null, [u.status === "active" ? el("span", { class: "pill pill--good" }, [el("span", { class: "pill__icon", text: "✓" }), u.hasPassword ? "Active" : "Invited"]) : el("span", { class: "pill pill--bad" }, [el("span", { class: "pill__icon", text: "!" }), "Disabled"])]),
        el("td", { class: "muted", text: u.lastLoginAt ? fmtWhen(u.lastLoginAt) : "Never" }),
        el("td", { class: "actions" }, [el("div", { class: "btn-row" }, [
          el("button", { class: "btn", type: "button", text: "Send password link", onclick: async function () { try { await api("POST", "/api/users/" + u.id + "/send-reset", {}); toast("Password link emailed to " + u.email); } catch (err) { toast(err.message, true); } } }),
          me ? null : (u.status === "active"
            ? el("button", { class: "btn", type: "button", text: "Disable", onclick: function () { userPatch(u, { status: "disabled" }); } })
            : el("button", { class: "btn", type: "button", text: "Enable", onclick: function () { userPatch(u, { status: "active" }); } })),
          me ? null : el("button", { class: "btn btn--link btn--danger", type: "button", text: "Delete", onclick: async function () { if (!confirm("Delete " + u.name + "? Their enquiries are kept.")) return; try { await api("DELETE", "/api/users/" + u.id); toast("Deleted"); loadUsers(); } catch (err) { toast(err.message, true); } } })
        ])])
      ]));
    });
    const ms = clear($("#mailStatus", v));
    const m = S.mail || { configured: false, recent: [] };
    ms.appendChild(el("p", null, [m.configured ? "SMTP is configured. " : "SMTP is not configured yet – alerts are being written to tracker/data/outbox.log on the server instead of being sent. See tracker/README.md. ",
      "Parts alerts go to " + S.config.partsEmail + ", advisor alerts to " + S.config.advisorsEmail + ", approvals to " + S.config.approverEmail + "."]));
    if (m.recent && m.recent.length) ms.appendChild(el("ul", null, m.recent.map(function (r) { return el("li", { text: fmtWhen(r.at) + " · " + r.subject + " → " + r.to.join(", ") + " · " + r.status }); })));
  }
  async function userPatch(u, body, okMsg) {
    try { await api("PATCH", "/api/users/" + u.id, body); if (okMsg) toast(okMsg); loadUsers(); } catch (err) { toast(err.message, true); loadUsers(); }
  }
  $("#userForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const f = ev.target, st = $("#userStatus");
    st.className = "dialog__status"; st.textContent = "Adding…";
    try {
      const d = await api("POST", "/api/users", { name: f.name.value, email: f.email.value, department: f.department.value, role: f.admin.checked ? "admin" : "staff" });
      $("#userDialog").close(); toast("Added " + d.user.name + " and emailed a password link"); loadUsers();
    } catch (err) { st.className = "dialog__status is-error"; st.textContent = err.message; }
  });

  // ---- password change ----------------------------------------------------------------------------
  $("#passwordForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    const f = ev.target, st = $("#passwordStatus");
    if (f.password.value !== f.confirm.value) { st.className = "dialog__status is-error"; st.textContent = "Passwords do not match."; return; }
    st.className = "dialog__status"; st.textContent = "Saving…";
    try { await api("POST", "/api/auth/change-password", { current: f.current.value, password: f.password.value }); $("#passwordDialog").close(); toast("Password updated"); f.reset(); }
    catch (err) { st.className = "dialog__status is-error"; st.textContent = err.message; }
  });

  // ---- header wiring ---------------------------------------------------------------------------------
  $("#btnNew").addEventListener("click", function () { if (currentRoute().path !== "/") { navigate("/"); } addRow(); });
  $("#btnUser").addEventListener("click", function (ev) { ev.stopPropagation(); const p = $("#userPanel"); p.hidden = !p.hidden; $("#btnUser").setAttribute("aria-expanded", String(!p.hidden)); });
  document.addEventListener("click", function () { $("#userPanel").hidden = true; });
  $("#userPanel").addEventListener("click", function (ev) { ev.stopPropagation(); });
  $$("[data-nav]").forEach(function (b) { b.addEventListener("click", function () { $("#userPanel").hidden = true; navigate(b.getAttribute("data-nav")); }); });
  $("#menuPassword").addEventListener("click", function () { $("#userPanel").hidden = true; $("#passwordForm").reset(); $("#passwordStatus").textContent = ""; $("#passwordDialog").showModal(); });
  $("#menuTheme").addEventListener("click", function () { $("#userPanel").hidden = true; toggleTheme(); });
  $("#btnThemeGuest").addEventListener("click", toggleTheme);
  $("#menuLogout").addEventListener("click", function () { $("#userPanel").hidden = true; logout(); });
  $$("dialog [data-close]").forEach(function (b) { b.addEventListener("click", function () { b.closest("dialog").close(); }); });
  $$("dialog").forEach(function (d) { d.addEventListener("click", function (ev) { if (ev.target === d) d.close(); }); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && S.user) { loadEnquiries(); loadNotifications(); } });

  // ---- boot -------------------------------------------------------------------------------------------
  async function boot() {
    applyTheme();
    try { S.config = await api("GET", "/api/config"); } catch (e) { S.config = { approverEmail: "steves@maxkirwan.com.au", partsEmail: "parts@maxkirwan.com.au", advisorsEmail: "advisors@maxkirwan.com.au", allowedDomains: ["maxkirwan.com.au"] }; }
    $("#dealerName").textContent = (S.config.dealerName || "Preston Mazda") + " · Service Department";
    $("#footStatus").textContent = "Data is kept on the dealership network only" + (S.config.encrypted ? " and encrypted at rest." : ".");
    try { const me = await api("GET", "/api/auth/me"); await afterLogin(me.user); }
    catch (e) { S.user = null; render(); }
  }
  boot();
})();

/* =====================================================================
   app.js – Mazda Service Dashboard
   State lives in localStorage; nothing is sent anywhere.
   ===================================================================== */
(function () {
  "use strict";
  const P = window.MZParse;
  const STORE_KEY = "mazda-service-dashboard.v1";

  const DEFAULT_SETTINGS = {
    dealerName: "Service Department",
    currency: "£",
    commissionRate: 6,
    msiBonus: 100,
    msiDeduction: 100,
    msiGreen: 95,
    msiAmber: 92,
    roGreen: 70,
    roAmber: 60,
    surveysPerDay: 1
  };

  // ---- state -------------------------------------------------------------
  let state = load();

  function thisMonth() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }
  function emptyState() {
    return { month: thisMonth(), settings: Object.assign({}, DEFAULT_SETTINGS), advisors: [], daily: [], department: {}, updatedAt: null };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyState();
      const s = JSON.parse(raw);
      const base = emptyState();
      s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
      return Object.assign(base, s);
    } catch (e) { return emptyState(); }
  }
  function save() {
    state.updatedAt = new Date().toISOString();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  }

  // ---- utilities -----------------------------------------------------------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  function fmtMoney(n, dp) {
    if (n == null || isNaN(n)) return "—";
    const cur = state.settings.currency || "";
    const abs = Math.abs(n);
    const s = abs.toLocaleString("en-GB", { minimumFractionDigits: dp == null ? 0 : dp, maximumFractionDigits: dp == null ? 0 : dp });
    return (n < 0 ? "−" : "") + cur + s;
  }
  function fmtNum(n, dp) {
    if (n == null || isNaN(n)) return "—";
    return n.toLocaleString("en-GB", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp == null ? 1 : dp });
  }
  function fmtPct(n, dp) { return n == null || isNaN(n) ? "—" : fmtNum(n, dp == null ? 1 : dp) + "%"; }

  // ---- calendar --------------------------------------------------------------
  function monthParts(ym) { const m = /^(\d{4})-(\d{2})$/.exec(ym || ""); return m ? { year: +m[1], month: +m[2] } : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }; }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function isWeekday(y, m, d) { const wd = new Date(y, m - 1, d).getDay(); return wd >= 1 && wd <= 5; }
  function workingDays(y, m, upToDay) {
    let n = 0; const last = Math.min(upToDay || 31, daysInMonth(y, m));
    for (let d = 1; d <= last; d++) if (isWeekday(y, m, d)) n++;
    return n;
  }
  function calendar() {
    const mp = monthParts(state.month);
    const now = new Date();
    const total = workingDays(mp.year, mp.month);
    let elapsed;
    const nowYM = now.getFullYear() * 100 + (now.getMonth() + 1);
    const selYM = mp.year * 100 + mp.month;
    if (selYM < nowYM) elapsed = total;
    else if (selYM > nowYM) elapsed = 0;
    else elapsed = workingDays(mp.year, mp.month, now.getDate());
    return { year: mp.year, month: mp.month, workingDays: total, elapsed: elapsed, label: new Date(mp.year, mp.month - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) };
  }

  // ---- status logic --------------------------------------------------------
  function msiStatus(score) {
    if (score == null || isNaN(score)) return "none";
    const s = state.settings;
    if (score >= s.msiGreen) return "good";
    if (score >= s.msiAmber) return "warn";
    return "bad";
  }
  function roStatus(count) {
    if (count == null || isNaN(count)) return "none";
    const s = state.settings;
    if (count >= s.roGreen) return "good";
    if (count >= s.roAmber) return "warn";
    return "bad";
  }
  const STATUS_LABEL = { good: "Green", warn: "Yellow", bad: "Red", none: "No data" };
  const STATUS_ICON = { good: "✓", warn: "!", bad: "✕", none: "–" };

  function pill(status, text, title) {
    return el("span", { class: "pill pill--" + status, title: title || STATUS_LABEL[status], "aria-label": (title || STATUS_LABEL[status]) + ": " + text }, [
      el("span", { class: "pill__icon", "aria-hidden": "true", text: STATUS_ICON[status] }),
      el("span", { text: text })
    ]);
  }

  // ---- derived figures -------------------------------------------------------
  function dailyByDate() {
    // { "YYYY-MM-DD": { total: n|null, advisors: { name: n } } } limited to selected month
    const cal = calendar();
    const prefix = cal.year + "-" + pad(cal.month) + "-";
    const out = {};
    state.daily.forEach(function (r) {
      if (r.date.indexOf(prefix) !== 0) return;
      const d = out[r.date] || (out[r.date] = { total: null, advisors: {} });
      if (r.advisor == null) d.total = r.count; else d.advisors[r.advisor] = r.count;
    });
    Object.keys(out).forEach(function (k) {
      const d = out[k];
      const names = Object.keys(d.advisors);
      if (d.total == null && names.length) d.total = names.reduce(function (a, n) { return a + d.advisors[n]; }, 0);
    });
    return out;
  }
  function latestDate(byDate) {
    const keys = Object.keys(byDate).sort();
    return keys.length ? keys[keys.length - 1] : null;
  }

  function computeAdvisors() {
    const s = state.settings;
    const cal = calendar();
    const byDate = dailyByDate();
    const latest = latestDate(byDate);
    const surveyTarget = cal.workingDays * s.surveysPerDay;
    const surveyTargetMTD = cal.elapsed * s.surveysPerDay;

    return state.advisors.map(function (a) {
      const gp = a.labourGP != null ? a.labourGP : a.labourGross;
      const status = msiStatus(a.msi);
      const base = gp != null ? gp * (s.commissionRate / 100) : null;
      const adj = status === "good" ? s.msiBonus : status === "bad" ? -s.msiDeduction : 0;
      const commission = base != null ? base + adj : null;

      // daily RO: today's figure from the log if present, else month average
      let dailyRO = null, dailyAvg = null, dailySource = "";
      const nameKey = a.name.toLowerCase();
      let logged = 0, loggedDays = 0;
      Object.keys(byDate).forEach(function (d) {
        const adv = byDate[d].advisors;
        const k = Object.keys(adv).find(function (n) { return n.toLowerCase() === nameKey; });
        if (k != null) { logged += adv[k]; loggedDays++; }
      });
      if (latest) {
        const adv = byDate[latest].advisors;
        const k = Object.keys(adv).find(function (n) { return n.toLowerCase() === nameKey; });
        if (k != null) { dailyRO = adv[k]; dailySource = "Latest day (" + fmtDay(latest) + ")"; }
      }
      if (loggedDays) dailyAvg = logged / loggedDays;
      if (dailyRO == null && a.roCount != null && cal.elapsed > 0) { dailyRO = a.roCount / cal.elapsed; dailyAvg = dailyRO; dailySource = "Average per working day"; }
      if (dailyRO == null && dailyAvg != null) { dailyRO = dailyAvg; dailySource = "Average per working day"; }

      return {
        name: a.name,
        labourGross: a.labourGross != null ? a.labourGross : null,
        labourGP: gp,
        commission: commission, commissionBase: base, commissionAdj: adj,
        msi: a.msi != null ? a.msi : null, msiStatus: status,
        surveys: a.surveys != null ? a.surveys : null,
        surveyTarget: surveyTarget, surveyTargetMTD: surveyTargetMTD,
        tyres: a.tyres != null ? a.tyres : null,
        bgOilFuel: a.bgOilFuel != null ? a.bgOilFuel : null,
        bgFlush: a.bgFlush != null ? a.bgFlush : null,
        acSan: a.acSan != null ? a.acSan : null,
        roCount: a.roCount != null ? a.roCount : (loggedDays ? logged : null),
        dailyRO: dailyRO, dailyAvg: dailyAvg, dailySource: dailySource,
        redPct: a.redPct != null ? a.redPct : null,
        amberPct: a.amberPct != null ? a.amberPct : null
      };
    });
  }

  function computeDepartment(advisors) {
    const o = state.department || {};
    const s = state.settings;
    const cal = calendar();
    const byDate = dailyByDate();
    const latest = latestDate(byDate);
    const sum = function (k) { let any = false, t = 0; advisors.forEach(function (a) { if (a[k] != null) { any = true; t += a[k]; } }); return any ? t : null; };

    const labourGross = o.labourGross != null ? o.labourGross : sum("labourGross");
    const surveys = o.surveys != null ? o.surveys : sum("surveys");
    let msi = o.msi;
    if (msi == null) {
      let w = 0, t = 0, n = 0, plain = 0;
      advisors.forEach(function (a) {
        if (a.msi == null) return;
        n++; plain += a.msi;
        if (a.surveys) { w += a.surveys; t += a.msi * a.surveys; }
      });
      msi = w ? t / w : (n ? plain / n : null);
    }
    const tyres = o.tyres != null ? o.tyres : sum("tyres");
    const roMonth = sum("roCount");
    const tyrePct = o.tyrePct != null ? o.tyrePct : (tyres != null && roMonth ? tyres / roMonth * 100 : null);
    const alignments = o.alignments != null ? o.alignments : null;

    let dailyRO = o.dailyRO != null ? o.dailyRO : null, dailySource = o.dailyRO != null ? "Entered" : "";
    if (dailyRO == null && latest && byDate[latest].total != null) { dailyRO = byDate[latest].total; dailySource = "Latest day (" + fmtDay(latest) + ")"; }
    if (dailyRO == null && roMonth != null && cal.elapsed > 0) { dailyRO = roMonth / cal.elapsed; dailySource = "Average per working day"; }
    const dailyValues = Object.keys(byDate).map(function (d) { return byDate[d].total; }).filter(function (v) { return v != null; });
    const dailyAvg = dailyValues.length ? dailyValues.reduce(function (a, b) { return a + b; }, 0) / dailyValues.length : (roMonth != null && cal.elapsed ? roMonth / cal.elapsed : null);
    const greenDays = dailyValues.filter(function (v) { return roStatus(v) === "good"; }).length;

    const surveyTarget = cal.workingDays * s.surveysPerDay * Math.max(advisors.length, 1);
    const surveyTargetMTD = cal.elapsed * s.surveysPerDay * Math.max(advisors.length, 1);

    return {
      labourGross: labourGross, msi: msi, msiStatus: msiStatus(msi), surveys: surveys, surveyTarget: surveyTarget, surveyTargetMTD: surveyTargetMTD,
      dailyRO: dailyRO, dailySource: dailySource, dailyAvg: dailyAvg, greenDays: greenDays, loggedDays: dailyValues.length,
      tyres: tyres, tyrePct: tyrePct, roMonth: roMonth, alignments: alignments, byDate: byDate, cal: cal
    };
  }

  function fmtDay(iso) {
    const p = iso.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  // ---- render: department tiles -----------------------------------------------
  function tile(opts) {
    const t = el("div", { class: "tile tile--status-" + (opts.status || "none") });
    t.appendChild(el("div", { class: "tile__label", text: opts.label }));
    t.appendChild(el("div", { class: "tile__value" + (opts.hero ? " tile__value--hero" : ""), text: opts.value }));
    if (opts.sub) { const sub = el("div", { class: "tile__sub" }); opts.sub.forEach(function (x) { sub.appendChild(typeof x === "string" ? el("span", { text: x }) : x); }); t.appendChild(sub); }
    if (opts.meter) {
      const m = el("div", { class: "meter", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(opts.meter.pct) });
      m.appendChild(el("div", { class: "meter__fill meter__fill--" + (opts.meter.status || "none"), style: "width:" + Math.max(0, Math.min(100, opts.meter.pct)) + "%" }));
      t.appendChild(m);
    }
    return t;
  }

  function renderDepartment(dept) {
    const wrap = $("#deptTiles");
    wrap.innerHTML = "";
    const cal = dept.cal;
    $("#deptMeta").textContent = cal.label + " · " + cal.elapsed + " of " + cal.workingDays + " working days elapsed";

    wrap.appendChild(tile({
      label: "Monthly labour gross",
      value: fmtMoney(dept.labourGross), hero: true,
      status: dept.labourGross != null ? "none" : "none",
      sub: [dept.labourGross != null && cal.elapsed ? "Run rate " + fmtMoney(dept.labourGross / cal.elapsed * cal.workingDays) + " for the month" : "Paste advisor labour gross to calculate"]
    }));

    const surveyStatus = dept.surveys == null ? "none" : dept.surveys >= dept.surveyTargetMTD ? "good" : dept.surveys >= dept.surveyTargetMTD * 0.8 ? "warn" : "bad";
    wrap.appendChild(tile({
      label: "MSI score",
      value: dept.msi != null ? fmtNum(dept.msi, 2) : "—",
      status: dept.msiStatus,
      sub: [pill(dept.msiStatus, STATUS_LABEL[dept.msiStatus], "MSI " + STATUS_LABEL[dept.msiStatus]),
            el("span", { text: dept.surveys != null ? fmtNum(dept.surveys, 0) + " surveys of " + dept.surveyTargetMTD + " due to date (" + dept.surveyTarget + " for the month)" : "No survey returns pasted" })],
      meter: dept.surveys != null ? { pct: dept.surveyTargetMTD ? dept.surveys / dept.surveyTargetMTD * 100 : 0, status: surveyStatus } : null
    }));

    const roSt = roStatus(dept.dailyRO);
    wrap.appendChild(tile({
      label: "Daily repair order count",
      value: dept.dailyRO != null ? fmtNum(dept.dailyRO, dept.dailySource.indexOf("Average") === 0 ? 1 : 0) : "—",
      status: roSt,
      sub: [pill(roSt, STATUS_LABEL[roSt], "Daily ROs " + STATUS_LABEL[roSt]), el("span", { text: dept.dailySource || "Paste daily repair orders" })]
    }));

    wrap.appendChild(tile({
      label: "Tyre sales",
      value: dept.tyres != null ? fmtNum(dept.tyres, 0) : "—",
      status: "none",
      sub: [dept.tyrePct != null ? fmtPct(dept.tyrePct) + " of repair orders" : (dept.roMonth == null ? "Add RO count or Tyre % for a rate" : "")]
    }));

    wrap.appendChild(tile({
      label: "Wheel alignment sales",
      value: dept.alignments != null ? fmtNum(dept.alignments, 0) : "—",
      status: "none",
      sub: [dept.alignments != null && dept.tyres ? fmtPct(dept.alignments / dept.tyres * 100, 0) + " of tyre sales" : "Paste in the Department tab"]
    }));
  }

  // ---- render: daily RO chart ---------------------------------------------------
  function renderChart(dept) {
    const wrap = $("#roChart");
    wrap.innerHTML = "";
    const cal = dept.cal;
    const byDate = dept.byDate;
    const days = [];
    for (let d = 1; d <= daysInMonth(cal.year, cal.month); d++) {
      if (!isWeekday(cal.year, cal.month, d)) continue;
      const iso = cal.year + "-" + pad(cal.month) + "-" + pad(d);
      days.push({ iso: iso, day: d, value: byDate[iso] ? byDate[iso].total : null });
    }
    const logged = days.filter(function (x) { return x.value != null; });
    if (!logged.length) {
      wrap.appendChild(el("p", { class: "chart__empty", text: "No daily repair order counts for " + cal.label + " yet. Paste them under Paste data → Daily repair orders." }));
      return;
    }
    const s = state.settings;
    const max = Math.max(s.roGreen * 1.15, Math.max.apply(null, logged.map(function (x) { return x.value; })) * 1.1);
    const inner = el("div", { class: "cols-wrap" });
    const cols = el("div", { class: "cols", role: "img", "aria-label": "Daily repair orders for " + cal.label });

    // gridlines: amber and green thresholds
    [{ v: s.roAmber, cls: "", label: s.roAmber + "" }, { v: s.roGreen, cls: "gridline--target", label: "Target " + s.roGreen }].forEach(function (g) {
      const y = g.v / max * 100;
      const line = el("div", { class: "gridline " + g.cls, style: "bottom:" + y + "%" });
      line.appendChild(el("span", { class: "gridline__label", text: g.label }));
      cols.appendChild(line);
    });

    days.forEach(function (x) {
      const st = x.value == null ? "none" : roStatus(x.value);
      const c = el("div", { class: "col", tabindex: x.value == null ? null : 0 });
      if (x.value != null) c.appendChild(el("div", { class: "col__val", text: fmtNum(x.value, 0) }));
      c.appendChild(el("div", { class: "col__bar col__bar--" + st, style: "height:" + (x.value == null ? 2 : Math.max(2, x.value / max * 100)) + "%" }));
      c.appendChild(el("div", { class: "col__day", text: x.day }));
      if (x.value != null) {
        const adv = byDate[x.iso].advisors; const names = Object.keys(adv);
        c.appendChild(el("div", { class: "col__tip", html: "<strong>" + esc(fmtDay(x.iso)) + "</strong> · " + fmtNum(x.value, 0) + " ROs · " + STATUS_LABEL[st] + (names.length ? "<br>" + names.map(function (n) { return esc(n) + " " + fmtNum(adv[n], 0); }).join(" · ") : "") }));
      }
      cols.appendChild(c);
    });
    inner.appendChild(cols);
    wrap.appendChild(inner);

    const summary = el("div", { class: "chart__summary" });
    summary.appendChild(el("span", { html: "Average <strong>" + fmtNum(dept.dailyAvg, 1) + "</strong> per day" }));
    summary.appendChild(el("span", { html: "<strong>" + dept.greenDays + "</strong> of " + dept.loggedDays + " logged days at 70+" }));
    if (dept.roMonth != null) summary.appendChild(el("span", { html: "Month to date <strong>" + fmtNum(dept.roMonth, 0) + "</strong> ROs" }));
    wrap.appendChild(summary);

    // table view for accessibility / print
    const tbl = el("details", { class: "chart__table" });
    tbl.appendChild(el("summary", { text: "Show as table", style: "cursor:pointer;font-size:13px;color:var(--ink-3);margin-top:8px" }));
    const t = el("table", { class: "preview", style: "margin-top:6px" });
    t.innerHTML = "<thead><tr><th>Date</th><th>ROs</th><th>Status</th></tr></thead>";
    const tb = el("tbody");
    logged.forEach(function (x) { tb.innerHTML += "<tr><td>" + esc(fmtDay(x.iso)) + "</td><td class='num'>" + fmtNum(x.value, 0) + "</td><td>" + STATUS_LABEL[roStatus(x.value)] + "</td></tr>"; });
    t.appendChild(tb); tbl.appendChild(t); wrap.appendChild(tbl);
  }

  // ---- render: leaderboard -----------------------------------------------------
  let sortKey = "labourGross", sortAsc = false;

  function renderBoard(advisors, dept) {
    const body = $("#boardBody");
    body.innerHTML = "";
    const s = state.settings;
    const rows = advisors.slice().sort(function (a, b) {
      const av = a[sortKey], bv = b[sortKey];
      if (sortKey === "name") return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortAsc ? av - bv : bv - av;
    });
    const maxGross = Math.max.apply(null, advisors.map(function (a) { return a.labourGross || 0; }).concat([1]));
    const rankOrder = advisors.slice().sort(function (a, b) { return (b.labourGross || 0) - (a.labourGross || 0); }).map(function (a) { return a.name; });

    rows.forEach(function (a) {
      const rank = rankOrder.indexOf(a.name) + 1;
      const tr = el("tr", { class: rank === 1 && a.labourGross ? "is-top" : "" });
      tr.appendChild(el("td", { class: "num rank rank--" + rank, text: rank }));
      tr.appendChild(el("td", { class: "name", text: a.name }));

      const gross = el("td", { class: "num strong" });
      gross.appendChild(document.createTextNode(fmtMoney(a.labourGross)));
      if (a.labourGross != null) { const bar = el("span", { class: "inline-bar", "aria-hidden": "true" }); bar.appendChild(el("span", { class: "inline-bar__fill", style: "width:" + (a.labourGross / maxGross * 100) + "%" })); gross.appendChild(bar); }
      tr.appendChild(gross);

      const com = el("td", { class: "num" });
      com.appendChild(document.createTextNode(fmtMoney(a.commission, 2)));
      if (a.commission != null) {
        const adjTxt = a.commissionAdj > 0 ? "+" + fmtMoney(a.commissionAdj) + " MSI bonus" : a.commissionAdj < 0 ? "−" + fmtMoney(Math.abs(a.commissionAdj)) + " MSI deduction" : "no MSI adjustment";
        com.appendChild(el("span", { class: "sub", text: s.commissionRate + "% of " + fmtMoney(a.labourGP) + " " + (a.commissionAdj ? (a.commissionAdj > 0 ? "+ " : "− ") + fmtMoney(Math.abs(a.commissionAdj)) : "") }));
        com.title = fmtMoney(a.commissionBase, 2) + " base, " + adjTxt;
      }
      tr.appendChild(com);

      const msi = el("td", { class: "num" });
      msi.appendChild(a.msi != null ? pill(a.msiStatus, fmtNum(a.msi, 2), "MSI " + STATUS_LABEL[a.msiStatus]) : el("span", { class: "muted", text: "—" }));
      tr.appendChild(msi);

      const sv = el("td", { class: "num" });
      if (a.surveys != null) {
        const onTrack = a.surveys >= a.surveyTargetMTD;
        const svSt = onTrack ? "good" : a.surveys >= a.surveyTargetMTD * 0.8 ? "warn" : "bad";
        sv.appendChild(pill(svSt, fmtNum(a.surveys, 0) + " / " + a.surveyTargetMTD, "Survey returns vs " + a.surveyTargetMTD + " due to date"));
        sv.appendChild(el("span", { class: "sub", text: a.surveyTarget + " target for the month" }));
      } else sv.appendChild(el("span", { class: "muted", text: "—" }));
      tr.appendChild(sv);

      tr.appendChild(el("td", { class: "num", text: fmtNum(a.tyres, 0) }));
      tr.appendChild(el("td", { class: "num", text: fmtNum(a.bgOilFuel, 0) }));
      tr.appendChild(el("td", { class: "num", text: fmtNum(a.bgFlush, 0) }));
      tr.appendChild(el("td", { class: "num", text: fmtNum(a.acSan, 0) }));

      const ro = el("td", { class: "num" });
      if (a.dailyRO != null) {
        ro.appendChild(el("span", { class: "strong", text: fmtNum(a.dailyRO, a.dailySource.indexOf("Average") === 0 ? 1 : 0) }));
        ro.appendChild(el("span", { class: "sub", text: a.dailySource.indexOf("Average") === 0 ? "avg per working day" : (a.dailyAvg != null ? "avg " + fmtNum(a.dailyAvg, 1) + " · " + fmtNum(a.roCount, 0) + " MTD" : a.dailySource) }));
        ro.title = a.dailySource;
      } else ro.appendChild(el("span", { class: "muted", text: "—" }));
      tr.appendChild(ro);

      tr.appendChild(el("td", { class: "num", text: fmtPct(a.redPct) }));
      tr.appendChild(el("td", { class: "num", text: fmtPct(a.amberPct) }));
      body.appendChild(tr);
    });

    $$("#board th[data-sort]").forEach(function (th) {
      th.classList.toggle("is-sorted", th.dataset.sort === sortKey);
      th.classList.toggle("asc", th.dataset.sort === sortKey && sortAsc);
      th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortAsc ? "ascending" : "descending") : "none");
    });

    $("#advMeta").textContent = advisors.length ? advisors.length + " advisors · ranked by labour gross · click a heading to sort" : "";
    $("#commissionNote").textContent = "* Commission = " + s.commissionRate + "% of labour gross profit (labour gross sales used when no GP column is pasted), plus " + fmtMoney(s.msiBonus) + " when MSI is green (" + s.msiGreen + "+) or less " + fmtMoney(s.msiDeduction) + " when MSI is red (below " + s.msiAmber + "). Survey target: " + s.surveysPerDay + " per working day, Monday to Friday. Adjust in Settings.";
  }

  // ---- render all ----------------------------------------------------------------
  function render() {
    $("#monthPicker").value = state.month;
    $("#dealerName").textContent = state.settings.dealerName || "Service Department";
    const advisors = computeAdvisors();
    const dept = computeDepartment(advisors);
    const has = advisors.length > 0 || state.daily.length > 0 || Object.keys(state.department || {}).length > 0;
    $("#emptyState").hidden = has;
    $$(".section:not(.section--empty)").forEach(function (sec) { sec.hidden = !has; });
    renderDepartment(dept);
    renderChart(dept);
    renderBoard(advisors, dept);
    $("#lastUpdated").textContent = state.updatedAt ? "Last updated " + new Date(state.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) + " · stored in this browser only" : "Data is stored in this browser only";
  }

  // ---- paste dialog --------------------------------------------------------------
  const pasteDialog = $("#pasteDialog");
  let activeTab = "advisors";

  function openPaste(tab) {
    if (tab) setTab(tab);
    $("#pastePreview").hidden = true;
    setStatus("");
    pasteDialog.showModal();
    $("#paste" + cap(activeTab)).focus();
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function setTab(tab) {
    activeTab = tab;
    $$(".tab").forEach(function (t) { const on = t.dataset.tab === tab; t.classList.toggle("is-active", on); t.setAttribute("aria-selected", on); });
    $$(".tabpanel").forEach(function (p) { p.hidden = p.dataset.panel !== tab; });
    $("#pastePreview").hidden = true;
    setStatus("");
  }
  function setStatus(msg, kind) {
    const s = $("#pasteStatus"); s.textContent = msg; s.className = "dialog__status" + (kind ? " is-" + kind : "");
  }

  function currentParse() {
    const text = $("#paste" + cap(activeTab)).value;
    const cal = calendar();
    if (activeTab === "advisors") return P.parseAdvisors(text);
    if (activeTab === "daily") return P.parseDaily(text, { year: cal.year, month: cal.month });
    return P.parseDepartment(text);
  }

  function showPreview(res) {
    const pv = $("#pastePreview");
    pv.innerHTML = "";
    pv.hidden = false;
    const notes = [];
    if (res.errors && res.errors.length) notes.push(res.errors.join(" "));
    if (res.unmatched && res.unmatched.length) notes.push("Ignored columns: " + res.unmatched.join(", ") + ".");
    if (activeTab === "advisors" && !res.hadHeader && res.rows.length) notes.push("No header row detected – columns were read in the template order.");
    if (notes.length) pv.appendChild(el("div", { class: "preview__note", text: notes.join(" ") }));

    if (activeTab === "advisors") {
      const cols = res.columns.filter(function (k) { return k; }).map(function (k) { return P.ADVISOR_FIELDS.find(function (f) { return f.key === k; }); });
      const t = el("table"); const thead = el("thead"); const trh = el("tr");
      cols.forEach(function (c) { trh.appendChild(el("th", { text: c.label })); }); thead.appendChild(trh); t.appendChild(thead);
      const tb = el("tbody");
      res.rows.forEach(function (r) { const tr = el("tr"); cols.forEach(function (c) { tr.appendChild(el("td", { class: c.key === "name" ? "" : "num", text: c.key === "name" ? r.name : (r[c.key] != null ? r[c.key] : "—") })); }); tb.appendChild(tr); });
      t.appendChild(tb); pv.appendChild(t);
      setStatus(res.rows.length + " advisor" + (res.rows.length === 1 ? "" : "s") + " found.", res.rows.length ? "ok" : "error");
    } else if (activeTab === "daily") {
      const t = el("table"); t.innerHTML = "<thead><tr><th>Date</th><th>Advisor</th><th>ROs</th></tr></thead>";
      const tb = el("tbody");
      res.rows.slice(0, 200).forEach(function (r) { tb.innerHTML += "<tr><td>" + esc(fmtDay(r.date)) + "</td><td>" + (r.advisor == null ? "<em>Department total</em>" : esc(r.advisor)) + "</td><td class='num'>" + r.count + "</td></tr>"; });
      t.appendChild(tb); pv.appendChild(t);
      const dates = {}; res.rows.forEach(function (r) { dates[r.date] = 1; });
      setStatus(res.rows.length + " entries across " + Object.keys(dates).length + " day(s) · " + (res.format || "") + " format.", res.rows.length ? "ok" : "error");
    } else {
      const t = el("table"); t.innerHTML = "<thead><tr><th>Field</th><th>Value</th></tr></thead>";
      const tb = el("tbody");
      P.DEPT_FIELDS.forEach(function (f) { if (res.values[f.key] != null) tb.innerHTML += "<tr><td>" + f.label + "</td><td class='num'>" + res.values[f.key] + "</td></tr>"; });
      t.appendChild(tb); pv.appendChild(t);
      const n = Object.keys(res.values).length;
      setStatus(n + " value" + (n === 1 ? "" : "s") + " recognised.", n ? "ok" : "error");
    }
  }

  function applyPaste() {
    const res = currentParse();
    if (activeTab === "advisors") {
      if (!res.rows.length) { showPreview(res); return; }
      state.advisors = res.rows;
    } else if (activeTab === "daily") {
      if (!res.rows.length) { showPreview(res); return; }
      const dates = {}; res.rows.forEach(function (r) { dates[r.date] = 1; });
      state.daily = state.daily.filter(function (r) { return !dates[r.date]; }).concat(res.rows);
      // adopt the pasted month if the dashboard month has no data yet
      const first = res.rows[0].date.slice(0, 7);
      if (first !== state.month && !state.daily.some(function (r) { return r.date.indexOf(state.month) === 0 && !dates[r.date]; })) state.month = first;
    } else {
      if (!Object.keys(res.values).length) { showPreview(res); return; }
      state.department = res.values;
    }
    save();
    render();
    pasteDialog.close();
  }

  // ---- settings ------------------------------------------------------------------
  const settingsDialog = $("#settingsDialog");
  const settingsForm = $("#settingsForm");
  function openSettings() {
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { const inp = settingsForm.elements[k]; if (inp) inp.value = state.settings[k]; });
    settingsDialog.showModal();
  }
  settingsForm.addEventListener("submit", function (e) {
    if (e.submitter && e.submitter.value === "cancel") return;
    const next = Object.assign({}, state.settings);
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      const inp = settingsForm.elements[k]; if (!inp) return;
      next[k] = inp.type === "number" ? (inp.value === "" ? DEFAULT_SETTINGS[k] : +inp.value) : (inp.value || DEFAULT_SETTINGS[k]);
    });
    state.settings = next; save(); render();
  });
  $("#btnSettingsReset").addEventListener("click", function () { Object.keys(DEFAULT_SETTINGS).forEach(function (k) { const inp = settingsForm.elements[k]; if (inp) inp.value = DEFAULT_SETTINGS[k]; }); });

  // ---- sample data ------------------------------------------------------------------
  function sample(kind) {
    const cal = calendar();
    const adv = ["Sam Carter", "Priya Shah", "Jordan Lee", "Chloe Evans"];
    if (kind === "advisors") return [
      P.templates.advisors,
      "Sam Carter\t£24,860\t£17,150\t96.4\t14\t38\t22\t9\t11\t196\t48.2%\t31.5%",
      "Priya Shah\t£22,310\t£15,400\t93.1\t12\t41\t18\t12\t8\t183\t44.7%\t28.9%",
      "Jordan Lee\t£19,975\t£13,780\t90.5\t9\t27\t15\t6\t5\t171\t39.0%\t22.4%",
      "Chloe Evans\t£17,240\t£11,900\t97.2\t15\t30\t20\t10\t9\t158\t51.6%\t35.2%"
    ].join("\n");
    if (kind === "daily") {
      const lines = ["Date\t" + adv.join("\t")];
      const seed = [[19, 18, 16, 15], [20, 17, 18, 14], [21, 19, 17, 16], [16, 15, 14, 12], [18, 16, 15, 14], [22, 20, 18, 17], [19, 18, 16, 15], [17, 15, 14, 13], [20, 19, 17, 16], [21, 18, 17, 15], [18, 17, 15, 14], [15, 14, 13, 11], [19, 18, 17, 16], [20, 19, 18, 16], [22, 21, 19, 18], [18, 17, 16, 15]];
      let i = 0;
      const lastDay = cal.elapsed ? Math.min(daysInMonth(cal.year, cal.month), new Date().getMonth() + 1 === cal.month && new Date().getFullYear() === cal.year ? new Date().getDate() : daysInMonth(cal.year, cal.month)) : 0;
      for (let d = 1; d <= lastDay && i < seed.length; d++) {
        if (!isWeekday(cal.year, cal.month, d)) continue;
        lines.push(pad(d) + "/" + pad(cal.month) + "/" + cal.year + "\t" + seed[i++].join("\t"));
      }
      return lines.join("\n");
    }
    return "Labour Gross\t£84,385\nMSI Score\t94.3\nSurvey Returns\t50\nTyre Sales\t136\nTyre %\t19.2\nWheel Alignments\t54";
  }
  function loadSampleAll() {
    const cal = calendar();
    const a = P.parseAdvisors(sample("advisors"));
    const d = P.parseDaily(sample("daily"), { year: cal.year, month: cal.month });
    const p = P.parseDepartment(sample("department"));
    state.advisors = a.rows; state.daily = d.rows; state.department = p.values;
    save(); render();
  }

  // ---- export / import --------------------------------------------------------------
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "service-dashboard-" + state.month + ".json" });
    document.body.appendChild(a); a.click(); a.remove();
  }
  $("#importFile").addEventListener("change", function (e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      try {
        const s = JSON.parse(r.result);
        if (!s || !Array.isArray(s.advisors)) throw new Error("bad");
        state = Object.assign(emptyState(), s); state.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
        save(); render();
      } catch (err) { alert("That file is not a dashboard export."); }
      e.target.value = "";
    };
    r.readAsText(f);
  });

  // ---- theme / display mode --------------------------------------------------------
  function applyTheme() {
    const t = localStorage.getItem("mazda-dashboard-theme");
    if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
  }
  $("#btnTheme").addEventListener("click", function () {
    const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    localStorage.setItem("mazda-dashboard-theme", cur === "dark" ? "light" : "dark");
    applyTheme();
  });
  $("#btnFullscreen").addEventListener("click", function () {
    if (document.fullscreenElement) { document.exitFullscreen(); } else { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }
  });
  document.addEventListener("fullscreenchange", function () { document.body.classList.toggle("is-display", !!document.fullscreenElement); });

  // ---- wiring --------------------------------------------------------------------------
  $("#btnPaste").addEventListener("click", function () { openPaste(); });
  $$("[data-open-paste]").forEach(function (b) { b.addEventListener("click", function () { openPaste("advisors"); }); });
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnSample").addEventListener("click", loadSampleAll);
  $("#btnExport").addEventListener("click", exportJSON);
  $("#btnClear").addEventListener("click", function () {
    if (!confirm("Clear all pasted data and settings from this browser?")) return;
    localStorage.removeItem(STORE_KEY); state = emptyState(); render();
  });
  $("#monthPicker").addEventListener("change", function (e) { if (e.target.value) { state.month = e.target.value; save(); render(); } });
  $$(".tab").forEach(function (t) { t.addEventListener("click", function () { setTab(t.dataset.tab); }); });
  $("#btnPreview").addEventListener("click", function () { showPreview(currentParse()); });
  $("#btnApply").addEventListener("click", applyPaste);
  $$("[data-copy-template]").forEach(function (b) {
    b.addEventListener("click", function () {
      const txt = P.templates[b.dataset.copyTemplate];
      const done = function () { const old = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = old; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { $("#paste" + cap(activeTab)).value = txt; done(); });
      else { $("#paste" + cap(activeTab)).value = txt; done(); }
    });
  });
  $$("[data-load-sample]").forEach(function (b) { b.addEventListener("click", function () { $("#paste" + cap(b.dataset.loadSample)).value = sample(b.dataset.loadSample); showPreview(currentParse()); }); });
  $$("#board th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      const k = th.dataset.sort;
      if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = k === "name"; }
      render();
    });
  });
  // Ctrl/Cmd+V anywhere on the page opens the paste dialog with the clipboard contents
  document.addEventListener("paste", function (e) {
    if (pasteDialog.open || settingsDialog.open) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    const txt = e.clipboardData && e.clipboardData.getData("text/plain");
    if (!txt || !txt.trim()) return;
    e.preventDefault();
    const guess = /^\s*date/i.test(txt) ? "daily" : (txt.split("\n").filter(Boolean).length <= 8 && txt.split("\n")[0].split("\t").length <= 2 ? "department" : "advisors");
    openPaste(guess);
    $("#paste" + cap(guess)).value = txt;
    showPreview(currentParse());
  });

  applyTheme();
  render();
})();

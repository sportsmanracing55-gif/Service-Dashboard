/* =====================================================================
   parse.js – turns pasted spreadsheet text into dashboard records.
   Pure functions; no DOM. Exposed on window.MZParse.
   ===================================================================== */
(function () {
  "use strict";

  // ---- helpers -------------------------------------------------------
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9%/&+ ]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function toNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s || s === "-" || s === "–" || /^n\/?a$/i.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[£$€,\s]/g, "").replace(/%$/, "");
    if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = parseFloat(s);
    return neg ? -n : n;
  }

  function splitRows(text) {
    return String(text || "").replace(/\r\n?/g, "\n").split("\n")
      .map(function (l) { return l.replace(/\s+$/, ""); })
      .filter(function (l) { return l.trim() !== ""; });
  }

  function detectDelimiter(lines) {
    const sample = lines.slice(0, 5).join("\n");
    if (sample.indexOf("\t") >= 0) return "\t";
    if (sample.indexOf(";") >= 0 && sample.split(";").length > sample.split(",").length) return ";";
    if (sample.indexOf(",") >= 0) return ",";
    if (/ {2,}/.test(sample)) return /\s{2,}/;
    return "\t";
  }

  function splitCells(line, delim) {
    if (delim === ",") {
      // minimal CSV: handle quoted cells
      const out = []; let cur = ""; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } }
        else if (c === "," && !q) { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur);
      return out.map(function (c) { return c.trim(); });
    }
    return line.split(delim).map(function (c) { return c.replace(/^"|"$/g, "").trim(); });
  }

  function toGrid(text) {
    const lines = splitRows(text);
    if (!lines.length) return [];
    const delim = detectDelimiter(lines);
    return lines.map(function (l) { return splitCells(l, delim); });
  }

  function looksLikeHeader(row) {
    const cells = row.filter(function (c) { return c !== ""; });
    if (!cells.length) return false;
    const numeric = cells.filter(function (c) { return toNumber(c) !== null; }).length;
    return numeric / cells.length < 0.5;
  }

  // ---- advisor column matching ----------------------------------------
  // Order matters: first matching rule wins.
  const ADVISOR_FIELDS = [
    { key: "name",        label: "Advisor",        test: function (h) { return /advisor|^name$|^sa$|service adv|^adv/.test(h); } },
    { key: "bgFlush",     label: "BG flush trio",  test: function (h) { return /flush|trio|3 ?pack|three/.test(h); } },
    { key: "bgOilFuel",   label: "BG oil + fuel",  test: function (h) { return /bg/.test(h) && /oil|fuel/.test(h) || /oil (&|and|\+|\/) ?fuel|oil ?fuel/.test(h); } },
    { key: "acSan",       label: "A/C sanitise",   test: function (h) { return /sanit|air ?con|a\/c|^ac\b|aircon/.test(h); } },
    { key: "labourGP",    label: "Labour GP",      test: function (h) { return /gross profit|\bgp\b|profit/.test(h); } },
    { key: "labourGross", label: "Labour gross",   test: function (h) { return /labou?r|gross|sales/.test(h) && !/tyre|tire|alignment|wheel/.test(h); } },
    { key: "msi",         label: "MSI score",      test: function (h) { return /msi|score|csi|nps/.test(h) && !/survey|return/.test(h); } },
    { key: "surveys",     label: "Surveys",        test: function (h) { return /survey|return|responses|reviews/.test(h); } },
    { key: "tyres",       label: "Tyres",          test: function (h) { return /tyre|tire/.test(h); } },
    { key: "redPct",      label: "Red sold %",     test: function (h) { return /\bred\b/.test(h); } },
    { key: "amberPct",    label: "Amber sold %",   test: function (h) { return /amber|yellow/.test(h); } },
    { key: "roCount",     label: "RO count",       test: function (h) { return /\bro\b|ros\b|repair order|jobs|job cards|\bwip\b|invoices/.test(h); } }
  ];
  const ADVISOR_DEFAULT_ORDER = ["name", "labourGross", "labourGP", "msi", "surveys", "tyres", "bgOilFuel", "bgFlush", "acSan", "roCount", "redPct", "amberPct"];
  const ADVISOR_TEMPLATE = "Advisor\tLabour Gross\tLabour GP\tMSI Score\tSurveys\tTyres\tBG Oil & Fuel\tBG Flush Trio\tA/C Sanitise\tRO Count\tRed %\tAmber %";

  function mapAdvisorHeader(headerRow) {
    const used = {};
    const map = []; const unmatched = [];
    headerRow.forEach(function (raw, i) {
      const h = norm(raw);
      let hit = null;
      for (let f = 0; f < ADVISOR_FIELDS.length; f++) {
        const fld = ADVISOR_FIELDS[f];
        if (!used[fld.key] && fld.test(h)) { hit = fld.key; break; }
      }
      if (hit) { used[hit] = true; map[i] = hit; } else { map[i] = null; if (raw) unmatched.push(raw); }
    });
    return { map: map, unmatched: unmatched };
  }

  function parseAdvisors(text) {
    const grid = toGrid(text);
    const result = { rows: [], unmatched: [], errors: [], hadHeader: false, columns: [] };
    if (!grid.length) { result.errors.push("Nothing to parse."); return result; }

    let map, body;
    if (looksLikeHeader(grid[0])) {
      const m = mapAdvisorHeader(grid[0]);
      map = m.map; result.unmatched = m.unmatched; body = grid.slice(1); result.hadHeader = true;
      if (map.indexOf("name") < 0) {
        // fall back: first column is the advisor name
        map[0] = "name";
      }
    } else {
      map = ADVISOR_DEFAULT_ORDER.slice(); body = grid;
    }
    result.columns = map;

    body.forEach(function (row, rIdx) {
      const rec = {};
      let any = false;
      row.forEach(function (cell, i) {
        const key = map[i];
        if (!key) return;
        if (key === "name") { rec.name = cell.trim(); return; }
        const n = toNumber(cell);
        if (n !== null) { rec[key] = n; any = true; }
      });
      if (!rec.name) { if (any) result.errors.push("Row " + (rIdx + 1) + " has no advisor name and was skipped."); return; }
      if (/^total/i.test(rec.name)) return; // skip spreadsheet total rows
      result.rows.push(rec);
    });
    return result;
  }

  // ---- dates -----------------------------------------------------------
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // Returns "YYYY-MM-DD" or null. `ctx` = {year, month} used when the cell has no year/month.
  function parseDate(raw, ctx) {
    let s = String(raw || "").trim().toLowerCase();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]);
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) {           // dd/mm/yyyy (UK)
      let y = +m[3]; if (y < 100) y += 2000;
      return y + "-" + pad(+m[2]) + "-" + pad(+m[1]);
    }
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})$/))) {                             // dd/mm (year from ctx)
      return ctx.year + "-" + pad(+m[2]) + "-" + pad(+m[1]);
    }
    if ((m = s.match(/^(?:[a-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:\s+(\d{2,4}))?$/))) { // 1 Sep 2026 / Mon 1st Sep
      const mi = MONTHS.indexOf(m[2].slice(0, 3));
      if (mi >= 0) { let y = m[3] ? +m[3] : ctx.year; if (y < 100) y += 2000; return y + "-" + pad(mi + 1) + "-" + pad(+m[1]); }
    }
    if ((m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2,4}))?$/))) { // Sep 1 2026
      const mi = MONTHS.indexOf(m[1].slice(0, 3));
      if (mi >= 0) { let y = m[3] ? +m[3] : ctx.year; if (y < 100) y += 2000; return y + "-" + pad(mi + 1) + "-" + pad(+m[2]); }
    }
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?$/))) {                             // bare day number
      return ctx.year + "-" + pad(ctx.month) + "-" + pad(+m[1]);
    }
    const d = new Date(s);
    if (!isNaN(d)) return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return null;
  }

  const DAILY_TEMPLATE_WIDE = "Date\tAdvisor 1\tAdvisor 2\tAdvisor 3\tTotal";

  // Returns { rows: [{date, advisor|null, count}], format, errors, unmatched }
  function parseDaily(text, ctx) {
    const grid = toGrid(text);
    const result = { rows: [], errors: [], format: null, advisors: [] };
    if (!grid.length) { result.errors.push("Nothing to parse."); return result; }

    let header = null, body = grid;
    if (looksLikeHeader(grid[0])) { header = grid[0]; body = grid.slice(1); }
    const h = header ? header.map(norm) : [];

    // Long format: Date | Advisor | Count
    const advCol = h.findIndex(function (c) { return /advisor|^name$|^sa$/.test(c); });
    const isLong = header ? advCol >= 0 : (grid[0].length === 3 && toNumber(grid[0][1]) === null && toNumber(grid[0][2]) !== null);
    if (isLong) {
      result.format = "long";
      const cntCol = header ? h.findIndex(function (c, i) { return i !== advCol && i !== 0 && /count|ro|total|jobs|number|qty/.test(c); }) : 2;
      const aCol = header ? advCol : 1;
      const nCol = cntCol >= 0 ? cntCol : (aCol === 1 ? 2 : 1);
      body.forEach(function (row, i) {
        const date = parseDate(row[0], ctx);
        if (!date) { result.errors.push("Row " + (i + 1) + ": could not read date '" + row[0] + "'."); return; }
        const name = (row[aCol] || "").trim();
        const n = toNumber(row[nCol]);
        if (!name || n === null) return;
        const isTotal = /^total|^dept|^department/i.test(name);
        result.rows.push({ date: date, advisor: isTotal ? null : name, count: n });
        if (!isTotal && result.advisors.indexOf(name) < 0) result.advisors.push(name);
      });
      return result;
    }

    // Wide format: Date | Advisor A | Advisor B | ... | Total?
    result.format = "wide";
    const names = header ? header.slice(1) : grid[0].slice(1).map(function (_, i) { return "Advisor " + (i + 1); });
    body.forEach(function (row, i) {
      const date = parseDate(row[0], ctx);
      if (!date) { result.errors.push("Row " + (i + 1) + ": could not read date '" + row[0] + "'."); return; }
      names.forEach(function (name, c) {
        const n = toNumber(row[c + 1]);
        if (n === null || !name) return;
        const isTotal = /^total|^dept|^department|^all$/i.test(name);
        result.rows.push({ date: date, advisor: isTotal ? null : name.trim(), count: n });
        if (!isTotal && result.advisors.indexOf(name.trim()) < 0) result.advisors.push(name.trim());
      });
    });
    return result;
  }

  // ---- department key/value -------------------------------------------
  const DEPT_FIELDS = [
    { key: "alignments",  label: "Wheel alignments", test: function (h) { return /align|geometry|wheel/.test(h); } },
    { key: "tyrePct",     label: "Tyre %",           test: function (h) { return /tyre|tire/.test(h) && /%|pct|percent|rate|per/.test(h); } },
    { key: "tyres",       label: "Tyre sales",       test: function (h) { return /tyre|tire/.test(h); } },
    { key: "labourGross", label: "Labour gross",     test: function (h) { return /labou?r|gross|sales/.test(h); } },
    { key: "msi",         label: "MSI score",        test: function (h) { return /msi|score|csi/.test(h) && !/survey|return/.test(h); } },
    { key: "surveys",     label: "Survey returns",   test: function (h) { return /survey|return/.test(h); } },
    { key: "dailyRO",     label: "Daily ROs",        test: function (h) { return /\bro\b|ros\b|repair|jobs|daily/.test(h); } }
  ];
  const DEPT_TEMPLATE = "Labour Gross\t\nMSI Score\t\nSurvey Returns\t\nTyre Sales\t\nTyre %\t\nWheel Alignments\t\nDaily ROs\t";

  function parseDepartment(text) {
    const grid = toGrid(text);
    const result = { values: {}, unmatched: [], errors: [] };
    if (!grid.length) { result.errors.push("Nothing to parse."); return result; }
    let pairs = [];
    if (grid.length === 2 && looksLikeHeader(grid[0]) && grid[0].length > 2) {
      grid[0].forEach(function (k, i) { pairs.push([k, grid[1][i]]); });        // header / value rows
    } else {
      grid.forEach(function (row) { if (row.length >= 2) pairs.push([row[0], row[row.length - 1]]); else if (row.length === 1) { const m = row[0].match(/^(.*?)[:=]\s*(.*)$/); if (m) pairs.push([m[1], m[2]]); } });
    }
    const used = {};
    pairs.forEach(function (p) {
      const h = norm(p[0]); const n = toNumber(p[1]);
      let hit = null;
      for (let i = 0; i < DEPT_FIELDS.length; i++) { if (!used[DEPT_FIELDS[i].key] && DEPT_FIELDS[i].test(h)) { hit = DEPT_FIELDS[i].key; break; } }
      if (!hit) { if (p[0]) result.unmatched.push(p[0]); return; }
      used[hit] = true;
      if (n !== null) result.values[hit] = n;
    });
    return result;
  }

  window.MZParse = {
    toNumber: toNumber, parseDate: parseDate, toGrid: toGrid,
    parseAdvisors: parseAdvisors, parseDaily: parseDaily, parseDepartment: parseDepartment,
    ADVISOR_FIELDS: ADVISOR_FIELDS, DEPT_FIELDS: DEPT_FIELDS,
    templates: { advisors: ADVISOR_TEMPLATE, daily: DAILY_TEMPLATE_WIDE, department: DEPT_TEMPLATE }
  };
})();

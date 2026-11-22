// ECA reply widgets. The agent writes a fenced block whose text is JSON starting with {"eca": "<kind>"};
// this turns it into a card, chart, table, list, timeline or email draft in ECA's style.
// Data only: every value goes in through textContent or as an SVG number. Nothing from the
// reply is ever parsed as HTML, so a reply cannot run code or load anything.
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var TONES = { good: "good", bad: "bad", warn: "warn", info: "info", neutral: "neutral" };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function tone(t) { return TONES[t] ? " t-" + TONES[t] : ""; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(v, unit) {
    if (typeof v !== "number") return String(v === undefined || v === null ? "" : v);
    var s = Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
                                : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (unit === "$") return "$" + s;
    if (unit === "%") return s + "%";
    return unit ? s + " " + unit : s;
  }
  function header(box, d) {
    if (d.title) box.appendChild(el("div", "w-title", d.title));
    if (d.subtitle) box.appendChild(el("div", "w-sub", d.subtitle));
  }
  function footer(box, d) {
    if (d.note) box.appendChild(el("div", "w-note", d.note));
  }

  // { eca: "kpis", title, items: [{label, value, unit?, delta?, tone?, hint?}] }
  function kpis(d) {
    var box = el("div", "eca-w w-kpis"); header(box, d);
    var grid = el("div", "w-kpi-grid");
    (d.items || []).slice(0, 12).forEach(function (it) {
      var c = el("div", "w-kpi" + tone(it.tone));
      c.appendChild(el("div", "w-kpi-l", it.label));
      c.appendChild(el("div", "w-kpi-v", fmt(it.value, it.unit)));
      if (it.delta !== undefined) c.appendChild(el("div", "w-kpi-d" + tone(it.tone), it.delta));
      if (it.hint) c.appendChild(el("div", "w-kpi-h", it.hint));
      grid.appendChild(c);
    });
    box.appendChild(grid); footer(box, d); return box;
  }

  // { eca: "bar", title, unit?, items: [{label, value, target?, tone?}], max? }
  function bar(d) {
    var box = el("div", "eca-w w-bar"); header(box, d);
    var items = (d.items || []).slice(0, 24);
    var max = num(d.max) || Math.max.apply(null, items.map(function (i) { return Math.max(num(i.value), num(i.target)); }).concat([1]));
    items.forEach(function (it) {
      var row = el("div", "w-bar-row");
      row.appendChild(el("div", "w-bar-l", it.label));
      var track = el("div", "w-bar-track");
      var fill = el("div", "w-bar-fill" + tone(it.tone));
      fill.style.width = Math.max(0, Math.min(100, num(it.value) / max * 100)) + "%";
      track.appendChild(fill);
      if (it.target !== undefined) {
        var tgt = el("div", "w-bar-target");
        tgt.style.left = Math.max(0, Math.min(100, num(it.target) / max * 100)) + "%";
        track.appendChild(tgt);
      }
      row.appendChild(track);
      row.appendChild(el("div", "w-bar-v", fmt(num(it.value), d.unit)));
      box.appendChild(row);
    });
    if (items.some(function (i) { return i.target !== undefined; })) box.appendChild(el("div", "w-legend", "▏ marker = target"));
    footer(box, d); return box;
  }

  // { eca: "line", title, unit?, labels: [..], series: [{name, values: [..], tone?}] }
  function line(d) {
    var box = el("div", "eca-w w-line"); header(box, d);
    var labels = (d.labels || []).slice(0, 60), series = (d.series || []).slice(0, 5);
    var W = 640, H = 220, P = 52, all = [];
    series.forEach(function (s) { (s.values || []).forEach(function (v) { all.push(num(v)); }); });
    var max = Math.max.apply(null, all.concat([1])), min = Math.min.apply(null, all.concat([0]));
    var longest = Math.max.apply(null, series.map(function (s) { return (s.values || []).length; }).concat([0]));
    var span = (max - min) || 1, n = Math.max(labels.length, longest, 2);
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "w-line-svg", role: "img" });
    for (var k = 0; k <= 4; k++) {
      var y = P + (H - 2 * P) * k / 4;
      g.appendChild(svg("line", { x1: P, x2: W - 8, y1: y, y2: y, class: "w-grid" }));
      var lab = svg("text", { x: P - 6, y: y + 4, class: "w-ylab", "text-anchor": "end" });
      lab.textContent = fmt(Math.round(max - (max - min) * k / 4), d.unit);
      g.appendChild(lab);
    }
    series.forEach(function (s, si) {
      var pts = (s.values || []).slice(0, n).map(function (v, i) {
        var x = P + (W - P - 8) * i / (n - 1), yy = H - P - (num(v) - min) / span * (H - 2 * P);
        return x.toFixed(1) + "," + yy.toFixed(1);
      });
      g.appendChild(svg("polyline", { points: pts.join(" "), class: "w-series s" + si + tone(s.tone) }));
    });
    box.appendChild(g);
    var axis = el("div", "w-axis");
    axis.appendChild(el("span", "", labels[0] || "")); axis.appendChild(el("span", "", labels[labels.length - 1] || ""));
    box.appendChild(axis);
    var leg = el("div", "w-legend");
    series.forEach(function (s, si) { var sp = el("span", "w-key s" + si + tone(s.tone), "● " + (s.name || "")); leg.appendChild(sp); });
    box.appendChild(leg); footer(box, d); return box;
  }

  // { eca: "table", title, columns: [..], rows: [[..]] | [{cells:[..], tone?, badge?}], align?: [..] }
  function table(d) {
    var box = el("div", "eca-w w-table"); header(box, d);
    var wrap = el("div", "w-table-wrap"), t = el("table");
    var thead = el("thead"), tr = el("tr");
    (d.columns || []).slice(0, 12).forEach(function (c, i) {
      var th = el("th", (d.align || [])[i] === "right" ? "r" : "", c); tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    (d.rows || []).slice(0, 300).forEach(function (r) {
      var cells = Array.isArray(r) ? r : (r.cells || []);
      var row = el("tr", Array.isArray(r) ? "" : tone(r.tone).trim());
      cells.slice(0, 12).forEach(function (c, i) {
        var td = el("td", (d.align || [])[i] === "right" ? "r" : "");
        if (c && typeof c === "object") {
          td.appendChild(el("span", "w-badge" + tone(c.tone), c.badge || c.text || ""));
        } else td.textContent = c === null || c === undefined ? "" : String(c);
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap); footer(box, d); return box;
  }

  // { eca: "list", title, summary?, items: [{title, detail?, meta?, badges?: [{text, tone}], tone?}] }
  function list(d) {
    var box = el("div", "eca-w w-list"); header(box, d);
    if (d.summary) box.appendChild(el("div", "w-summary", d.summary));
    (d.items || []).slice(0, 200).forEach(function (it) {
      var row = el("div", "w-li" + tone(it.tone));
      var main = el("div", "w-li-main");
      main.appendChild(el("div", "w-li-t", it.title));
      if (it.detail) main.appendChild(el("div", "w-li-d", it.detail));
      row.appendChild(main);
      var side = el("div", "w-li-side");
      (it.badges || []).slice(0, 4).forEach(function (b) { side.appendChild(el("span", "w-badge" + tone(b.tone), b.text)); });
      if (it.meta) side.appendChild(el("span", "w-li-m", it.meta));
      row.appendChild(side);
      box.appendChild(row);
    });
    footer(box, d); return box;
  }

  // { eca: "timeline", title, items: [{time, title, who?, detail?, tone?, badge?}] }
  function timeline(d) {
    var box = el("div", "eca-w w-timeline"); header(box, d);
    (d.items || []).slice(0, 200).forEach(function (it) {
      var row = el("div", "w-tl" + tone(it.tone));
      row.appendChild(el("div", "w-tl-time", it.time));
      row.appendChild(el("div", "w-tl-dot"));
      var body = el("div", "w-tl-body");
      var top = el("div", "w-tl-top");
      top.appendChild(el("span", "w-tl-t", it.title));
      if (it.badge) top.appendChild(el("span", "w-badge" + tone(it.tone), it.badge));
      body.appendChild(top);
      if (it.who || it.detail) body.appendChild(el("div", "w-tl-d", [it.who, it.detail].filter(Boolean).join(" · ")));
      row.appendChild(body);
      box.appendChild(row);
    });
    footer(box, d); return box;
  }

  // { eca: "draft", to, cc?, subject, body, status? }
  function draft(d) {
    var box = el("div", "eca-w w-draft");
    var head = el("div", "w-draft-head");
    head.appendChild(el("span", "w-draft-k", "Email draft"));
    head.appendChild(el("span", "w-badge t-good", d.status || "Saved to Drafts · you review and send"));
    box.appendChild(head);
    [["To", d.to], ["Cc", d.cc], ["Subject", d.subject]].forEach(function (p) {
      if (!p[1]) return;
      var r = el("div", "w-draft-f"); r.appendChild(el("span", "w-draft-l", p[0])); r.appendChild(el("span", "", p[1])); box.appendChild(r);
    });
    box.appendChild(el("div", "w-draft-body", d.body || ""));
    return box;
  }

  var KINDS = { kpis: kpis, bar: bar, line: line, table: table, list: list, timeline: timeline, draft: draft };

  function parse(text) {
    var s = (text || "").trim();
    if (s.charAt(0) !== "{" || s.indexOf('"eca"') < 0 || s.length > 200000) return null;
    try { var d = JSON.parse(s); return d && KINDS[d.eca] ? d : null; } catch (e) { return "partial"; }
  }

  // A long block is not drawn as code at all: the engine folds it into a small "json · Code" chip
  // (data-slot="aui_artifact-card") and keeps the text only in the component's own props. Without
  // this, any card over ~3 KB (a 40-row call list) showed as that chip (found 11-22).
  function chipText(card) {
    try {
      var key = Object.keys(card).filter(function (k) { return k.indexOf("__reactFiber") === 0; })[0];
      var f = key ? card[key] : null;
      for (var i = 0; i < 8 && f; i++, f = f.return) {
        var p = f.memoizedProps;
        if (p && typeof p.code === "string") return p.code;
      }
    } catch (e) {}
    return "";
  }

  function upgrade(code, chip) {
    // The engine wraps fenced code in its own "code card" (data-slot="code-card"); the widget goes
    // beside that card, never inside it, so the card's code font and height limit do not apply.
    var pre = chip ? code : (code.closest('[data-slot="code-card"]') || code.closest("pre") || code);
    var text = chip ? chipText(code) : code.textContent;
    if (pre.dataset.ecaSeen === text) return;
    pre.dataset.ecaSeen = text;
    var d = parse(text);
    var host = pre.parentNode;
    if (!host) return;
    var old = pre.previousElementSibling && pre.previousElementSibling.classList &&
              pre.previousElementSibling.classList.contains("eca-w-host") ? pre.previousElementSibling : null;
    if (d === null) { if (old) old.remove(); pre.classList.remove("eca-w-src"); return; }
    var w;
    if (d === "partial") { w = el("div", "eca-w w-loading", "Building the view…"); }
    else {
      try { w = KINDS[d.eca](d); } catch (e) { w = null; }
      if (!w) return;
      var tog = el("button", "w-toggle", "data");
      tog.type = "button";
      tog.addEventListener("click", function () { pre.classList.toggle("eca-w-show"); });
      w.appendChild(tog);
    }
    var wrap = el("div", "eca-w-host");
    wrap.appendChild(w);
    if (old) old.replaceWith(wrap); else host.insertBefore(wrap, pre);
    pre.classList.add("eca-w-src");
  }

  function scan() {
    var codes = document.querySelectorAll("pre code, pre");
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (c.tagName === "PRE" && c.querySelector("code")) continue;
      var t = c.textContent || "";
      if (t.indexOf('"eca"') < 0) {
        var p = c.closest('[data-slot="code-card"]') || c.closest("pre") || c;
        if (p.dataset.ecaSeen) upgrade(c);
        continue;
      }
      upgrade(c);
    }
    var chips = document.querySelectorAll('[data-slot="aui_artifact-card"]');
    for (var j = 0; j < chips.length; j++) {
      if (chips[j].dataset.ecaSeen || chipText(chips[j]).indexOf('"eca"') >= 0) upgrade(chips[j], true);
    }
  }
  var queued = false;
  function later() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; scan(); }); }
  try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  if (document.readyState !== "loading") scan(); else document.addEventListener("DOMContentLoaded", scan);
  window.__ecaWidgets = { scan: scan, kinds: Object.keys(KINDS) };
})();

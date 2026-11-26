// PROPOSED replacement for skin/skin.js. Changes vs today are marked "P5" / "P8" (see spec.md).
// ECA layer over the agent workspace: the name, whose workspace it is, a way
// to sign out, and one plain prompt while the leader's Claude account is not
// connected yet. It never touches a login: the leader signs in inside the
// Claude program.
(function () {
  // A tab that holds no key for the workspace yet (a new tab, a bookmark, a
  // browser restart) asks for a fresh one-use link instead of showing a dead page.
  try {
    var KEY = "hermes.webapp.session.v1:" + JSON.stringify([location.origin, ""]);
    if (!sessionStorage.getItem(KEY)) {
      var tries = Number(sessionStorage.getItem("eca.opentries") || 0);
      if (tries < 2) {
        sessionStorage.setItem("eca.opentries", String(tries + 1));
        location.replace("/_eca/open");
        return;
      }
    } else {
      sessionStorage.removeItem("eca.opentries");
    }
  } catch (e) {}

  var TITLE = "ECA Agent", MARK = "ECA AGENT";
  var TAGLINE = "Ask about the clubs, have a report built, or hand me a task.";

  // ── What stays on the screen ──────────────────────────────────────────────
  // Leaders get: chat, past conversations, files, schedules. The engine's own
  // set-up areas (providers, catalogues, profiles, messaging bridges) are
  // hidden, and its maker's names do not appear.
  var HIDE_MENU = { "Capabilities": 1, "Messaging": 1 };
  var BLOCKED_ROUTES = /^#\/(capabilities|messaging|settings|profiles|gateways|kanban|connectors|plugins|skills)(\/|\?|$)/;
  // Never touched: what people and the agent wrote.
  var KEEP = '[data-slot="aui_thread-content"],[data-slot="row-button"],[data-slot="pane-tab"],[role="textbox"],textarea,input,#eca-banner,#eca-chip,#eca-logo,#eca-side-mark,.xterm,pre,code';
  var CHROME_IN_THREAD = '[data-slot="aui_error-card"],[data-slot="aui_system-message-root"],[data-slot="aui_response-loading"]';
  var SWAPS = [
    [/Claude Subscription DirectSDK \(Experimental\)/g, "Claude"],
    [/claude-subscription-directsdk-experimental:\s*/g, ""],
    [/(https?:\/\/)?hermes-agent\.nousresearch\.com[^\s"'<>)]*/gi, "my guide"],
    [/Waking up default\b/g, "Waking up"],
    [/HERMES AGENT/g, MARK],
    [/Hermes (Agent|Webapp|Desktop)/g, "ECA Agent"],
    [/\bHermes\b/g, "ECA Agent"]
  ];
  var OUTSIDE = /\bNous\b/;

  function swap(text) {
    for (var i = 0; i < SWAPS.length; i++) text = text.replace(SWAPS[i][0], SWAPS[i][1]);
    return text;
  }
  function hideFor(el) {
    var dialog = el.closest('[role="dialog"]');
    if (dialog) {
      // A set-up dialog of the engine's own: close it, and take the person to ECA's Connect page.
      var close = dialog.querySelector('button[aria-label="Close"],[data-slot="dialog-close"]');
      var wantsProvider = /model provider|API key/i.test(dialog.textContent || "");
      if (close) close.click(); else dialog.setAttribute("data-eca-hide", "");
      if (wantsProvider) location.assign("/_eca/connect");
      return;
    }
    (el.closest('button,a,[role="menuitem"],[role="option"],[role="tab"],li,label') || el).setAttribute("data-eca-hide", "");
  }
  function scrubWithin(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) return (n !== root && n.matches(KEEP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node, outside = [];
    while ((node = walker.nextNode())) {
      var before = node.nodeValue;
      if (before.length < 4) continue;
      var after = swap(before);
      if (after !== before) node.nodeValue = after;
      if (OUTSIDE.test(after) && node.parentElement) outside.push(node.parentElement);
    }
    for (var i = 0; i < outside.length; i++) hideFor(outside[i]);
    var labelled = root.querySelectorAll("[aria-label],[title],[placeholder],[data-placeholder]");
    for (var j = 0; j < labelled.length; j++) {
      var el = labelled[j];
      // Placeholders are the screen's own hint text, never what someone typed: always scrubbed.
      var inKept = el.closest(KEEP) && !el.closest(CHROME_IN_THREAD);
      (inKept ? ["placeholder", "data-placeholder"] : ["aria-label", "title", "placeholder", "data-placeholder"]).forEach(function (attr) {
        var v = el.getAttribute(attr);
        if (!v) return;
        var w = swap(v);
        if (w !== v) el.setAttribute(attr, w);
        if (OUTSIDE.test(w)) hideFor(el);
      });
    }
  }
  // Tool labels inside an answer ("Mcp.hermes-tools.skill View") are the screen's own wording, not
  // the person's or the agent's text, so the engine's name is taken out of them too. Only text
  // inside the small tool buttons is touched; the conversation itself is left exactly as written.
  function toolLabels() {
    var btns = document.querySelectorAll('[data-slot="aui_thread-content"] button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.closest(".eca-w-host") || !/hermes/i.test(b.textContent || "")) continue;
      var tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT), tn;
      while ((tn = tw.nextNode())) {
        var v = tn.nodeValue, w = v.replace(/\bMcp\.hermes-tools\./gi, "").replace(/\bhermes[-_ ]tools\b/gi, "tools");
        w = swap(w);
        if (w !== v) tn.nodeValue = w.charAt(0).toUpperCase() + w.slice(1);
      }
    }
  }
  // The character keeps you company beside an open chat: it thinks while the agent works, talks
  // while an answer arrives, and for a few seconds afterwards looks pleased or concerned by what
  // the answer's cards say (their "good" / "bad" tones). On the empty screen the large one takes over.
  var pal = null, palState = "idle", palLen = 0, palTimer = null;
  function companion() {
    var gem = window.ECAEmerald; if (!gem) return;
    var open = !!document.querySelector('[data-slot="aui_thread-content"]') && !document.querySelector("p.wordmark") &&
               !document.getElementById("eca-intro") && window.innerWidth >= 900;
    document.documentElement.classList.toggle("eca-pal-on", open);
    if (!open) { if (pal) pal.style.display = "none"; if (palState !== "idle") { palState = "idle"; clearTimeout(palTimer); gem.mood("idle"); } return; }
    if (!pal) {
      pal = el("div", { id: "eca-pal", "aria-hidden": "true" });
      var cv = el("canvas", {}); pal.appendChild(cv);
      document.body.appendChild(pal);
      if (!gem.attach(cv, { mode: "idle", face: true })) { pal.remove(); pal = null; return; }
    }
    pal.style.display = "";
    var loading = document.querySelector('[data-slot="aui_response-loading"]');
    // An answer is arriving while its text block is not yet marked complete. (The engine's
    // "streaming marker" element is no use: it stays in every finished message.)
    var streaming = document.querySelector('[data-slot="aui_assistant-message-content"] [data-status]:not([data-status="complete"])');
    var msgs = document.querySelectorAll('[data-slot="aui_assistant-message-content"]');
    var lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    if (loading) {
      if (palState !== "thinking") { palState = "thinking"; clearTimeout(palTimer); gem.mood("thinking"); }
    } else if (streaming) {
      if (palState !== "speaking") { palState = "speaking"; clearTimeout(palTimer); gem.mood("speaking"); palLen = 0; }
      var n = lastMsg ? (lastMsg.textContent || "").length : 0;
      if (n > palLen) { gem.talk(420); gem.beat(0.7); }
      palLen = n;
    } else if (palState === "thinking" || palState === "speaking") {
      // The answer is in. Read its cards: more red than green is concern, any green is pleased.
      palState = "after"; gem.mood("idle");
      clearTimeout(palTimer);
      palTimer = setTimeout(function () {                      // the cards are drawn a moment after the text completes
        if (palState !== "after") return;
        var all = document.querySelectorAll('[data-slot="aui_assistant-message-content"]'), m = all.length ? all[all.length - 1] : null;
        var bad = m ? m.querySelectorAll(".eca-w .t-bad").length : 0, good = m ? m.querySelectorAll(".eca-w .t-good").length : 0;
        gem.mood(bad > good ? "worried" : good > 0 ? "happy" : "idle");
        palTimer = setTimeout(function () { if (palState === "after") { palState = "idle"; gem.mood("idle"); } }, 7000);
      }, 500);
    }
  }
  // Change the words of an element the engine drew without replacing its text nodes: the engine
  // keeps a handle on each text node and removes it itself later; a node swapped out from under it
  // crashes the whole screen ("removeChild ... not a child of this node").
  function setWords(elm, text) {
    var first = null;
    for (var c = elm.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 3) continue;
      if (!first) { first = c; if (c.nodeValue !== text) c.nodeValue = text; }
      else if (c.nodeValue) c.nodeValue = "";
    }
    if (!first) elm.appendChild(document.createTextNode(text));
  }
  // The sidebar's own words, in ECA's: conversations are "chats". Only the screen's labels are
  // touched (exact matches), never a chat's own title.
  var RELABEL = { "Hermes": "ECA Agent", "Sessions": "Chats", "New session": "New chat", "Cron jobs": "Scheduled", "Search sessions...": "Search chats" };
  function relabel() {
    var spots = document.querySelectorAll('[data-slot="pane-tab"][aria-label="Sessions"] span, button[class*="section-label"] span, li[data-slot="sidebar-menu-item"] span, [data-slot="pane-tab"] span');
    for (var i = 0; i < spots.length; i++) {
      var sp = spots[i];
      if (sp.children.length) continue;
      var t = (sp.textContent || "").trim(), to = RELABEL[t] || RELABEL[t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()];
      if (to && sp.textContent !== to) setWords(sp, to);
      if (to === "New chat") { var li = sp.closest('li[data-slot="sidebar-menu-item"]'); if (li && !li.classList.contains("eca-new")) li.classList.add("eca-new"); }
    }
    var inputs = document.querySelectorAll('[data-slot="sidebar"] input[placeholder]');
    for (var j = 0; j < inputs.length; j++) {
      if (/^Search sessions/.test(inputs[j].getAttribute("placeholder") || "")) inputs[j].setAttribute("placeholder", "Search chats");
    }
  }
  function strip() {
    relabel();
    botGems();
    toolLabels();
    thinkingGems();
    companion();
    if (document.title !== TITLE) document.title = TITLE;
    if (BLOCKED_ROUTES.test(location.hash)) { location.hash = "#/"; }
    var items = document.querySelectorAll('li[data-slot="sidebar-menu-item"]');
    for (var i = 0; i < items.length; i++) {
      if (HIDE_MENU[(items[i].textContent || "").trim()]) items[i].setAttribute("data-eca-hide", "");
      // "Artifacts" reads as "Files" in the sidebar (decision 4).
      var tw = document.createTreeWalker(items[i], NodeFilter.SHOW_TEXT), tn;
      while ((tn = tw.nextNode())) { if (tn.nodeValue.trim() === "Artifacts") tn.nodeValue = tn.nodeValue.replace("Artifacts", "Files"); }
    }
    var marks = document.querySelectorAll("p.wordmark");
    for (var m = 0; m < marks.length; m++) {
      var p = marks[m], changed = false;
      if (p.getAttribute("aria-label") !== MARK) p.setAttribute("aria-label", MARK);
      var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue === "HERMES AGENT") { node.nodeValue = MARK; changed = true; }
      }
      var tag = p.nextElementSibling;
      if (tag && tag.tagName === "P" && tag.textContent !== TAGLINE) setWords(tag, TAGLINE);
      if (changed) { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }
      logo(p);
    }
    sideMark();
    if (document.body) {
      scrubWithin(document.body);
      var inThread = document.querySelectorAll(CHROME_IN_THREAD);
      for (var k = 0; k < inThread.length; k++) scrubWithin(inThread[k]);
    }
  }
  // P5. The ECA logo beside the big wordmark, and a small monogram at the top of the sidebar.
  // Images are served from the skin folder (/_eca/static/). Decorative: the wordmark keeps the name.
  var STATIC = "/_eca/static/";
  // The emerald is the assistant's face on the empty screen: the stone, then its greeting.
  // The engine's big wordmark stays in the page as the accessible name but is not drawn.
  var firstName = "";
  function hello() {
    var hr = new Date().getHours(), g = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    return g + (firstName ? ", " + firstName : "") + ".";
  }
  function logo(p) {
    if (!p.classList.contains("eca-has-logo")) p.classList.add("eca-has-logo");
    var prev = p.previousElementSibling;
    if (prev && prev.id === "eca-gem-wrap") {
      var line = prev.querySelector("#eca-gem-hello");
      if (line && line.getAttribute("data-said") && line.getAttribute("data-name") !== firstName && !line.getAttribute("data-busy")) {
        line.setAttribute("data-name", firstName); line.textContent = hello();
      }
      return;
    }
    var old = document.getElementById("eca-gem-wrap"); if (old) old.remove();
    old = document.getElementById("eca-logo"); if (old) old.remove();
    var wrap = el("div", { id: "eca-gem-wrap", "aria-hidden": "true" });
    var cv = el("canvas", { id: "eca-gem-hero" }), line = el("div", { id: "eca-gem-hello" });
    wrap.appendChild(cv); wrap.appendChild(line);
    p.parentNode.insertBefore(wrap, p);
    var gem = window.ECAEmerald;
    if (gem && gem.attach(cv, { mode: "idle" })) {
      line.setAttribute("data-busy", "1"); line.setAttribute("data-name", firstName);
      gem.say(line, hello(), function () { line.removeAttribute("data-busy"); line.setAttribute("data-said", "1"); });
    } else {
      cv.remove(); line.textContent = hello(); line.setAttribute("data-said", "1"); line.setAttribute("data-name", firstName);
    }
  }
  // While the agent is working, a small emerald turns where the engine's square blinks.
  function thinkingGems() {
    var gem = window.ECAEmerald; if (!gem) return;
    var spots = document.querySelectorAll('[data-slot="aui_response-loading"]');
    for (var i = 0; i < spots.length; i++) {
      if (spots[i].querySelector(".eca-gem-think")) continue;
      var cv = el("canvas", { "class": "eca-gem-think", "aria-hidden": "true" });
      spots[i].insertBefore(cv, spots[i].firstChild);
      if (gem.attach(cv, { mode: "thinking" })) spots[i].classList.add("eca-has-gem"); else cv.remove();
    }
  }
  // Bot faces: every bot is a small stone of its own colour. The engine draws a face as
  // svg[data-bot-face="<bot name>"]; that drawing is hidden and a stone sits in its place, its
  // colour decided by the bot's name (same name, same colour, on every screen). The main agent
  // keeps the emerald green. Uploaded pictures are not touched.
  // Six colours that cannot be mistaken for each other or for the main agent's green, and five
  // cuts: thirty looks. The colour and the cut are picked separately from the name.
  var GEM_COLOURS = [
    "hue-rotate(215deg) saturate(1.5)",                    // pink ruby
    "hue-rotate(255deg) saturate(1.7) brightness(1.1)",    // fire orange
    "hue-rotate(285deg) saturate(1.6) brightness(1.25)",   // gold
    "hue-rotate(85deg) saturate(1.5)",                     // sapphire
    "hue-rotate(135deg) saturate(1.3)",                    // amethyst
    "saturate(.08) brightness(1.35)"                       // diamond
  ];
  var GEM_CUTS = ["round", "square", "kite", "crystal", "shield"];
  var GEM_NAMES = ["Ruby", "Fire", "Gold", "Sapphire", "Amethyst", "Diamond"];
  var GEM_SWATCH = ["#ff5fa8", "#ff7a3d", "#ffc531", "#3fa9ff", "#9a7bff", "#e8eef0"];
  // What the person picked (kept in their workspace, so it follows them to any browser), and the
  // pick being made in an open New bot window before the bot exists.
  var LOOKS = {}, PENDING = null;
  function loadLooks() {
    fetch("/_eca/bot-looks", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.looks) { LOOKS = d.looks; later(); } })
      .catch(function () {});
  }
  function saveLook(name, pick) {
    name = String(name || "").toLowerCase();
    if (!name) return;
    if (pick.c == null && pick.k == null) delete LOOKS[name]; else LOOKS[name] = { c: pick.c, k: pick.k };
    fetch("/_eca/bot-looks", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, c: pick.c == null ? null : pick.c, k: pick.k || null }) }).catch(function () {});
  }
  function gemLook(name, pick) {
    name = String(name || "").toLowerCase();
    pick = pick || LOOKS[name] || {};
    var main = !name || name === "default" || name === "hermes" || name === "eca agent";
    var h = 0, g = 7;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) >>> 0; g = (g * 131 + name.charCodeAt(i) * 7 + 3) >>> 0; }
    var c = pick.c != null && GEM_COLOURS[pick.c] ? pick.c : (main ? -1 : h % GEM_COLOURS.length);
    var k = pick.k || (main ? "emerald" : GEM_CUTS[g % GEM_CUTS.length]);
    return { filter: c < 0 ? "" : GEM_COLOURS[c], cut: k, c: c, k: k };
  }
  // The picker in the New bot / Edit bot window: a row of colours and a row of cuts, each with
  // "Auto" (let the name decide). In the New bot window the pick is saved when the bot is created.
  function pickerFor(dialog, gem, name, isNew) {
    var box = dialog.querySelector("#eca-gem-pick");
    var pick = isNew ? (PENDING || (PENDING = { c: null, k: null })) : (LOOKS[String(name).toLowerCase()] || { c: null, k: null });
    if (!box) {
      var anchor = null, notes = dialog.querySelectorAll("div,p,span");
      for (var n = 0; n < notes.length; n++) {
        if (!notes[n].children.length && /^(Face follows the name\.?|Pick a stone.*)$/i.test((notes[n].textContent || "").trim())) { anchor = notes[n]; break; }
      }
      if (!anchor) return;
      setWords(anchor, "Pick a stone, or leave both on Auto and the name decides.");
      box = el("div", { id: "eca-gem-pick" });
      var rowC = el("div", { "class": "eca-pick-row", "data-kind": "c" }), rowK = el("div", { "class": "eca-pick-row", "data-kind": "k" });
      rowC.appendChild(el("span", { "class": "eca-pick-label" }, "Colour"));
      rowK.appendChild(el("span", { "class": "eca-pick-label" }, "Cut"));
      rowC.appendChild(el("button", { type: "button", "class": "eca-pick-auto", "data-v": "" }, "Auto"));
      rowK.appendChild(el("button", { type: "button", "class": "eca-pick-auto", "data-v": "" }, "Auto"));
      for (var c = 0; c < GEM_COLOURS.length; c++) {
        var sw = el("button", { type: "button", "class": "eca-pick-sw", "data-v": String(c), title: GEM_NAMES[c], "aria-label": GEM_NAMES[c] });
        sw.style.background = "radial-gradient(circle at 35% 30%, #fff8, transparent 45%), " + GEM_SWATCH[c];
        rowC.appendChild(sw);
      }
      for (var k = 0; k < GEM_CUTS.length; k++) {
        var cb = el("button", { type: "button", "class": "eca-pick-cut", "data-v": GEM_CUTS[k], title: GEM_CUTS[k], "aria-label": GEM_CUTS[k] + " cut" });
        var cc = el("canvas", { "aria-hidden": "true" });
        cb.appendChild(cc); rowK.appendChild(cb);
      }
      box.appendChild(rowC); box.appendChild(rowK);
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
      var cvs = box.querySelectorAll(".eca-pick-cut canvas");
      for (var q = 0; q < cvs.length; q++) gem.attach(cvs[q], { mode: "calm", face: true, cut: cvs[q].parentNode.getAttribute("data-v") });
      box.addEventListener("click", function (ev) {
        var btn = ev.target.closest ? ev.target.closest("button[data-v]") : null;
        if (!btn) return;
        ev.preventDefault(); ev.stopPropagation();
        var kind = btn.parentNode.getAttribute("data-kind"), v = btn.getAttribute("data-v");
        var fresh = box.__isNew ? PENDING : { c: (LOOKS[box.__name] || {}).c, k: (LOOKS[box.__name] || {}).k };
        if (fresh.c === undefined) fresh.c = null;
        if (fresh.k === undefined) fresh.k = null;
        if (kind === "c") fresh.c = v === "" ? null : Number(v); else fresh.k = v || null;
        if (!box.__isNew) saveLook(box.__name, fresh);
        later();
      });
    }
    box.__isNew = isNew; box.__name = String(name || "").toLowerCase();
    var shown = gemLook(name, pick);
    var all = box.querySelectorAll("button[data-v]");
    for (var i = 0; i < all.length; i++) {
      var kind = all[i].parentNode.getAttribute("data-kind"), v = all[i].getAttribute("data-v");
      var on = kind === "c" ? (v === "" ? pick.c == null : pick.c === Number(v)) : (v === "" ? !pick.k : pick.k === v);
      if (all[i].classList.contains("eca-on") !== on) all[i].classList.toggle("eca-on", on);
      var pcv = all[i].querySelector("canvas");
      if (pcv && pcv.style.filter !== shown.filter) pcv.style.filter = shown.filter;       // the cuts are shown in the chosen colour
    }
  }
  var FACE_PICKER = /^(round|organic|boxy|capsule|nub|cloud|droplet|hexagon|sun|triangle|Auto\b.*)$/i;
  function botGems() {
    var gem = window.ECAEmerald;
    if (!gem) return;
    var faces = document.querySelectorAll("svg[data-bot-face]");
    for (var i = 0; i < faces.length; i++) {
      var svg = faces[i], name = svg.getAttribute("data-bot-face") || "";
      var cv = svg.previousElementSibling;
      if (!cv || !cv.classList || !cv.classList.contains("eca-bot-gem")) {
        var size = Math.round(svg.getBoundingClientRect().width || Number(svg.getAttribute("width")) || 34);
        if (size < 12) continue;
        cv = el("canvas", { "class": "eca-bot-gem", "aria-hidden": "true" });
        cv.style.width = cv.style.height = size + "px";
        svg.parentNode.insertBefore(cv, svg);
        if (!gem.attach(cv, { mode: "calm", face: size >= 26 })) { cv.remove(); continue; }
        svg.classList.add("eca-face-off");
      }
      var inDialog = svg.closest('[role="dialog"]');
      var look = gemLook(name, inDialog && inDialog.querySelector('#eca-gem-pick') && inDialog.querySelector('#eca-gem-pick').__isNew ? PENDING : null);
      var sig = name + "|" + look.c + "|" + look.k;
      if (cv.getAttribute("data-for") !== sig) {
        cv.setAttribute("data-for", sig);
        cv.style.filter = look.filter;
        gem.cut(cv, look.cut);
      }
    }
    // a stone whose drawing the engine has since removed
    var stray = document.querySelectorAll("canvas.eca-bot-gem");
    for (var j = 0; j < stray.length; j++) {
      var nx = stray[j].nextElementSibling;
      if (!nx || !nx.hasAttribute || !nx.hasAttribute("data-bot-face")) stray[j].remove();
    }
    // The New bot / Edit bot window: the engine's face shapes, "Randomize" and "Lock face" give
    // way to ECA's stone picker.
    var dialogs = document.querySelectorAll('[role="dialog"]'), anyNew = false;
    for (var d = 0; d < dialogs.length; d++) {
      var dg = dialogs[d], btns = dg.querySelectorAll("button"), isBot = !!dg.querySelector("#eca-gem-pick"), isNew = false;
      for (var b = 0; b < btns.length; b++) {
        if (btns[b].closest("#eca-gem-pick")) continue;
        var t = (btns[b].getAttribute("aria-label") || btns[b].textContent || "").trim();
        if (FACE_PICKER.test(t) || /^(Randomize|Lock face|Unlock face|Classic shapes|Blob faces)$/i.test(t)) { btns[b].setAttribute("data-eca-hide", ""); isBot = true; }
        if (/^Create bot$/i.test(t)) isNew = true;
      }
      if (!isBot) continue;
      var face = null, fs = dg.querySelectorAll("svg[data-bot-face]");
      for (var f = 0; f < fs.length; f++) { if (!fs[f].closest("button")) { face = fs[f]; break; } }
      if (!face) continue;
      if (isNew) anyNew = true;
      pickerFor(dg, gem, face.getAttribute("data-bot-face") || "", isNew);
    }
    if (!anyNew) PENDING = null;
  }
  function sideMark() {
    if (document.getElementById("eca-side-mark")) return;
    var head = document.querySelector('[data-slot="sidebar-header"]');   // [verify] slot name
    if (!head) return;
    var m = el("div", { id: "eca-side-mark" });
    m.appendChild(el("img", { src: STATIC + "eca-mark-dark.png", alt: "" }));
    m.appendChild(el("span", null, "ECA Agent"));
    head.insertBefore(m, head.firstChild);
  }
  // The engine's own ChatGPT sign-in box: ECA's Connect page does the same sign-in in the
  // ChatGPT program itself, which the engine then reuses. Send the person there (once per
  // ten minutes, so a failed hand-over can never loop).
  function engineSignIn() {
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      if (/Sign in with ChatGPT/.test(dialogs[i].textContent || "")) {
        try {
          var last = Number(sessionStorage.getItem("eca.connectHop") || 0);
          if (Date.now() - last < 600000) return;
          sessionStorage.setItem("eca.connectHop", String(Date.now()));
        } catch (e) {}
        location.assign("/_eca/connect");
        return;
      }
    }
  }
  function brand() { strip(); engineSignIn(); }
  var queued = false;
  function later() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; strip(); declineStats(); engineSignIn(); }); }
  try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  window.addEventListener("hashchange", later);
  // The engine's own "sign in" prompts lead to ECA's Connect page instead of its set-up screens.
  document.addEventListener("click", function (ev) {
    // "Create bot": keep the stone picked in that window under the bot's name.
    var cb = ev.target && ev.target.closest ? ev.target.closest("button") : null;
    if (cb && PENDING && (PENDING.c != null || PENDING.k) && /^Create bot$/i.test((cb.textContent || "").trim())) {
      var dlg = cb.closest('[role="dialog"]'), pv = dlg && dlg.querySelector("canvas.eca-bot-gem + svg[data-bot-face]");
      if (pv) saveLook(pv.getAttribute("data-bot-face"), { c: PENDING.c, k: PENDING.k });
    }
  }, true);
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
    if (btn && btn.closest('[data-slot="aui_error-card"]') && /^Sign in to (Claude|ChatGPT|OpenAI)/.test((btn.textContent || "").trim())) {
      ev.preventDefault(); ev.stopPropagation(); location.assign("/_eca/connect");
    }
  }, true);

  var dismissed = false;
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }
  function signOut() {
    fetch("/_eca/sign-out", { method: "POST", credentials: "same-origin" })
      .catch(function () {})
      .then(function () {
        try { sessionStorage.clear(); localStorage.clear(); } catch (e) {}
        location.replace("/_eca/signed-out?bye=1");
      });
  }
  // P8. Identity chip: initials avatar with a Claude status dot, "ECA" + name, Sign out.
  // When Claude is not connected it also offers "Reconnect Claude". On a phone it collapses
  // to the avatar; tapping the avatar reveals the buttons.
  function initials(name) {
    var parts = String(name).replace(/,/g, " ").trim().split(/\s+/);
    return ((parts[0] || "")[0] || "").toUpperCase() + ((parts.length > 1 ? parts[parts.length - 1][0] : "") || "").toUpperCase();
  }
  var service = "Claude";
  function chip(name, claudeOn) {
    if (!name) return;
    var c = document.getElementById("eca-chip");
    if (!c) {
      c = el("div", { id: "eca-chip", role: "group", "aria-label": "Your ECA account" });
      var av = el("button", { type: "button", "class": "eca-av", "aria-label": "Account" }, initials(name));
      av.addEventListener("click", function () { c.classList.toggle("eca-open"); });
      c.appendChild(av);
      c.appendChild(el("span", { "class": "eca-org" }, "ECA"));
      c.appendChild(el("span", { "class": "eca-name" }, name));
      var re = el("button", { type: "button", "class": "eca-reconnect", hidden: "" }, "Reconnect " + service);
      re.addEventListener("click", function () { location.assign("/_eca/connect"); });
      c.appendChild(re);
      var con = el("button", { type: "button", "class": "eca-connections", title: "What your agent is connected to" }, "Connections");
      con.addEventListener("click", function () { location.assign("/_eca/connections"); });
      c.appendChild(con);
      var dis = el("button", { type: "button", "class": "eca-disconnect", title: "Remove your AI sign-in from this workspace" }, "Disconnect AI");
      dis.addEventListener("click", function () {
        if (!confirm("Disconnect your " + service + " sign-in from your ECA agent? Your chats and files stay. You can connect again any time.")) return;
        fetch("/_eca/disconnect-ai", { method: "POST", credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d) { alert("Could not disconnect. Reload and try again."); return; }
            alert(service + " is disconnected from your ECA agent." + (d.revoke_note ? "\n\n" + d.revoke_note : ""));
            location.assign("/_eca/connect");
          });
      });
      c.appendChild(dis);
      var out = el("button", { type: "button", "aria-label": "Sign out of your agent on this browser" }, "Sign out");
      out.addEventListener("click", signOut);
      c.appendChild(out);
      document.body.appendChild(c);
    }
    c.classList.toggle("eca-claude-off", claudeOn === false);
    var r = c.querySelector(".eca-reconnect");
    if (claudeOn === false) r.removeAttribute("hidden"); else r.setAttribute("hidden", "");
  }
  function banner(show) {
    var old = document.getElementById("eca-banner");
    if (!show || dismissed) { if (old) old.remove(); return; }
    if (old) return;
    var b = el("div", { id: "eca-banner", role: "status" });
    var text = el("div");
    var head = el("div"); head.appendChild(el("b", null, "One step left: connect your " + service + " account."));
    text.appendChild(head);
    text.appendChild(el("div", { "class": "eca-sub" }, "Your agent runs on your own " + service + " membership. It takes about a minute."));
    var actions = el("div", { "class": "eca-actions" });
    var go = el("button", { type: "button" }, "Connect " + service);
    go.addEventListener("click", function () { location.assign("/_eca/connect"); });
    var hide = el("button", { type: "button", "class": "eca-quiet" }, "Later");
    hide.addEventListener("click", function () { dismissed = true; banner(false); });
    actions.appendChild(go); actions.appendChild(hide);
    b.appendChild(text); b.appendChild(actions);
    document.body.appendChild(b);
  }
  // ECA's default is not to send usage statistics to the software's maker: the
  // question is answered "No thanks" once, so leaders are not asked.
  var declined = false;
  function declineStats() {
    if (declined) return;
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].textContent.trim() === "No thanks" && buttons[i].parentElement &&
          /Share usage stats\?/.test((buttons[i].parentElement.parentElement || buttons[i].parentElement).textContent || "")) {
        declined = true; buttons[i].click(); return;
      }
    }
  }
  var timer = null;
  function check() {
    fetch("/_eca/whoami", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.service) service = d.service;
        if (d.name) firstName = String(d.name).trim().split(/\s+/)[0] || "";
        chip(d.name, d.claude_signed_in);
        var needs = d.claude_signed_in === false;
        banner(needs);
        clearTimeout(timer);
        if (needs && !dismissed) timer = setTimeout(check, 8000);
      })
      .catch(function () {});
  }
  function start() { brand(); check(); loadLooks(); }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();

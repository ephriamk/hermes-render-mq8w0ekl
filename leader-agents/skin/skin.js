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

  function brand() {
    if (document.title !== TITLE) document.title = TITLE;
    var marks = document.querySelectorAll("p.wordmark");
    for (var i = 0; i < marks.length; i++) {
      var p = marks[i], changed = false;
      if (p.getAttribute("aria-label") === "HERMES AGENT") p.setAttribute("aria-label", MARK);
      var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue === "HERMES AGENT") { node.nodeValue = MARK; changed = true; }
      }
      if (changed) { try { window.dispatchEvent(new Event("resize")); } catch (e) {} }
    }
  }
  var queued = false;
  function later() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; brand(); declineStats(); }); }
  try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

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
  function chip(name) {
    if (!name || document.getElementById("eca-chip")) return;
    var c = el("div", { id: "eca-chip" });
    c.appendChild(el("span", null, "ECA · " + name));
    var out = el("button", { type: "button", title: "Sign out of this workspace on this browser" }, "Sign out");
    out.addEventListener("click", signOut);
    c.appendChild(out);
    document.body.appendChild(c);
  }
  function banner(show) {
    var old = document.getElementById("eca-banner");
    if (!show || dismissed) { if (old) old.remove(); return; }
    if (old) return;
    var b = el("div", { id: "eca-banner", role: "status" });
    var text = el("div");
    var head = el("div"); head.appendChild(el("b", null, "One step left: connect your Claude account."));
    text.appendChild(head);
    text.appendChild(el("div", { "class": "eca-sub" }, "Your agent runs on your own Claude membership. It takes about a minute."));
    var actions = el("div", { "class": "eca-actions" });
    var go = el("button", { type: "button" }, "Connect Claude");
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
        chip(d.name);
        var needs = d.claude_signed_in === false;
        banner(needs);
        clearTimeout(timer);
        if (needs && !dismissed) timer = setTimeout(check, 8000);
      })
      .catch(function () {});
  }
  function start() { brand(); check(); }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();

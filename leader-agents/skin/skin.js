// ECA layer over the agent workspace: the name, whose workspace it is, and one
// plain prompt while the leader's Claude account is not connected yet.
// It never touches a login: the leader signs in inside the Claude program.
(function () {
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
  function later() { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; brand(); }); }
  brand();
  try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

  var dismissed = false;
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }
  function chip(name) {
    if (!name || document.getElementById("eca-chip")) return;
    document.body.appendChild(el("div", { id: "eca-chip" }, "ECA · " + name));
  }
  function banner(show) {
    var old = document.getElementById("eca-banner");
    if (!show || dismissed) { if (old) old.remove(); return; }
    if (old) return;
    var b = el("div", { id: "eca-banner", role: "status" });
    var text = el("div");
    var head = el("div"); head.appendChild(el("b", null, "One step left: connect your Claude account."));
    text.appendChild(head);
    var ol = el("ol");
    var li1 = el("li", null, "Open the Terminal panel (right side of this screen).");
    var li2 = el("li"); li2.appendChild(document.createTextNode("Type ")); li2.appendChild(el("code", null, "claude auth login"));
    li2.appendChild(document.createTextNode(" and press Enter."));
    var li3 = el("li", null, "Open the link it prints, approve with your own Claude account, and paste the code back.");
    ol.appendChild(li1); ol.appendChild(li2); ol.appendChild(li3);
    text.appendChild(ol);
    var actions = el("div", { "class": "eca-actions" });
    var again = el("button", { type: "button" }, "I've signed in");
    again.addEventListener("click", function () { check(true); });
    var hide = el("button", { type: "button", "class": "eca-quiet" }, "Hide");
    hide.addEventListener("click", function () { dismissed = true; banner(false); });
    actions.appendChild(again); actions.appendChild(hide);
    b.appendChild(text); b.appendChild(actions);
    document.body.appendChild(b);
  }
  var timer = null;
  function check(force) {
    fetch("/_eca/whoami" + (force ? "?now=1" : ""), { credentials: "same-origin", cache: "no-store" })
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
  if (document.body) check(); else document.addEventListener("DOMContentLoaded", function () { check(); });
})();

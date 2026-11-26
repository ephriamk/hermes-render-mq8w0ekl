// The Connections list. Data only: every label goes in with textContent.
(function () {
  var main = document.querySelector("main");
  var svc = main.dataset.service, aiOn = main.dataset.ai === "1", portal = main.dataset.portal;
  var ITEMS = [
    { name: svc, icon: svc === "Claude" ? "i-claude" : "i-openai", group: aiOn ? "Connected" : "Available",
      desc: "Your own plan. It powers your agent.",
      action: aiOn ? { label: "Disconnect", quiet: true, run: disconnect } : { label: "Connect", href: "/_eca/connect" } },
    { name: "ECA data", img: "/_eca/static/eca-mark-dark.png", group: "Connected", state: "Always on",
      desc: "Dashboards, Stats, schedule, sales, members and pay, as your portal shows them." },
    { name: "ECA knowledge", icon: "i-book", group: "Connected", state: "Always on",
      desc: "What every ECA number means, and the ECA playbook." },
    { name: "Gmail", icon: "i-gmail", group: "Available", google: true, desc: "Search and read your mail.",
      action: { label: "Connect", href: portal } },
    { name: "Google Calendar", icon: "i-gcal", group: "Available", google: true, desc: "See your meetings alongside the club schedule.",
      action: { label: "Connect", href: portal } },
    { name: "Google Drive", icon: "i-gdrive", group: "Available", google: true, desc: "Search and read your Docs, Sheets and Slides.",
      action: { label: "Connect", href: portal } },
    { name: "Google Sheets", icon: "i-sheets", group: "Coming soon", desc: "Update trackers and greensheets." },
    { name: "Slack", icon: "i-slack", group: "Coming soon", desc: "Briefs and questions in a channel." },
    { name: "GymSales", icon: "i-people", group: "Coming soon", desc: "Live leads and tours." },
    { name: "Paychex", icon: "i-paychex", group: "Coming soon", desc: "Hours and checks, read only. Admins." },
    { name: "Text messages", icon: "i-message", group: "Coming soon", desc: "Draft follow-up texts for you to approve." }
  ];
  var ORDER = ["Connected", "Available", "Coming soon"];
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; }
  function disconnect(btn) {
    if (!confirm("Disconnect " + svc + " from your ECA agent? Your chats and files stay.")) return;
    btn.disabled = true;
    fetch("/_eca/disconnect-ai", { method: "POST", credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { alert("Could not disconnect. Reload and try again."); btn.disabled = false; return; }
        if (d.revoke_note) alert(d.revoke_note);
        location.reload();
      });
  }
  var list = document.getElementById("list"), empty = document.getElementById("empty"), query = "";
  function draw() {
    list.textContent = "";
    var any = false;
    ORDER.forEach(function (g) {
      var rows = ITEMS.filter(function (it) {
        return it.group === g && (!query || (it.name + " " + it.desc).toLowerCase().indexOf(query) >= 0);
      });
      if (!rows.length) return;
      any = true;
      list.appendChild(el("h2", "", g));
      var box = el("div", "group");
      rows.forEach(function (it) {
        var row = el("div", "item" + (g === "Coming soon" ? " soon" : ""));
        var ico = el("div", "ico");
        if (it.img) { var im = el("img"); im.src = it.img; im.alt = ""; ico.appendChild(im); }
        else ico.appendChild(el("i", it.icon));
        row.appendChild(ico);
        var body = el("div", "body"); body.appendChild(el("div", "name", it.name)); body.appendChild(el("div", "desc", it.desc));
        row.appendChild(body);
        var side = el("div", "side"), a = it.action;
        if (it.state) side.appendChild(el("span", "state", it.state));
        if (a && a.href) { var l = el("a", "btn" + (a.quiet ? " quiet" : ""), a.label); l.href = a.href; l.rel = "noreferrer noopener";
          if (a.blank) l.target = "_blank"; side.appendChild(l); }
        else if (a) { var b = el("button", "btn" + (a.quiet ? " quiet" : ""), a.label); b.type = "button";
          b.addEventListener("click", function () { a.run(b); }); side.appendChild(b); }
        row.appendChild(side);
        box.appendChild(row);
      });
      list.appendChild(box);
    });
    empty.hidden = any;
  }
  // Google through the person's own ChatGPT: ChatGPT's official Gmail / Calendar / Drive apps. The
  // supervisor asks their ChatGPT which are connected; Connect opens ChatGPT's own page for that app
  // (Google's sign-in, ChatGPT's approved app), and coming back to this tab checks again.
  var googleVia = null;
  function applyApps(d) {
    if (!d || !d.via) return;
    googleVia = d.via;
    ITEMS.forEach(function (it) {
      var info = it.google && d.apps[it.name]; if (!info) return;
      if (info.connected) {
        it.group = "Connected"; it.state = "Through your " + d.via;
        it.action = { label: "Manage", quiet: true, href: info.connect_url, blank: true };
      } else {
        it.group = "Available"; it.state = d.checked ? "" : "Could not check";
        it.action = { label: "Connect", href: info.connect_url, blank: true };
      }
    });
    var note = document.getElementById("gnote");
    if (note) {
      note.textContent = "Google connects through your ChatGPT account. Connect opens ChatGPT in a new tab: " +
        (d.account ? "check it is signed in as " + d.account + " (the account your agent uses), " : "") +
        "connect the app with your ECA Google account, then come back here.";
      note.hidden = false;
    }
    draw();
  }
  var lastCheck = 0;
  function checkApps(fresh) {
    if (Date.now() - lastCheck < 4000) return; lastCheck = Date.now();
    ITEMS.forEach(function (it) { if (it.google && it.group === "Available" && googleVia) it.state = "Checking…"; });
    if (googleVia) draw();
    fetch("/_eca/apps" + (fresh ? "?fresh=1" : ""), { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; }).then(applyApps).catch(function () {});
  }
  window.addEventListener("focus", function () { if (googleVia) checkApps(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && googleVia) checkApps(true); });
  document.getElementById("q").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); draw(); });
  draw();
  if (aiOn) checkApps(false);
})();

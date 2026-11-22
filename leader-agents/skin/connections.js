// The Connections gallery. Data only: every label goes in with textContent.
(function () {
  var main = document.querySelector("main");
  var svc = main.dataset.service, aiOn = main.dataset.ai === "1", portal = main.dataset.portal;
  var ITEMS = [
    { id: "ai", name: svc, by: "Your AI plan", ico: svc[0], c: svc === "Claude" ? "#e6865f" : "#4fd1b0",
      state: aiOn ? "on" : "available", desc: "Powers your agent's thinking, on the plan you already have.",
      can: ["Answers", "Reports", "Analysis"],
      action: aiOn ? { label: "Disconnect", ghost: true, run: disconnect } : { label: "Connect", href: "/_eca/connect" } },
    { id: "eca", name: "ECA data", by: "Emerald City Athletics", ico: "E", c: "#7ed957", state: "on",
      desc: "Dashboards, Stats, schedule, classes, sales, members and pay, exactly as your portal shows them.",
      can: ["Read only", "Your clubs", "Every lookup logged"], action: { label: "Always on", disabled: true } },
    { id: "kb", name: "ECA knowledge", by: "Emerald City Athletics", ico: "K", c: "#a3e635", state: "on",
      desc: "What every ECA number means and how the playbook works: 199 topics.",
      can: ["Definitions", "Playbook", "Glossary"], action: { label: "Always on", disabled: true } },
    { id: "gmail", name: "Gmail", by: "Google Workspace", ico: "M", c: "#f87171", state: "available",
      desc: "Find and read your email, and write drafts for you to review. It never sends.",
      can: ["Search", "Read", "Draft only"], action: { label: "Set up in the portal", href: portal } },
    { id: "gcal", name: "Google Calendar", by: "Google Workspace", ico: "31", c: "#60a5fa", state: "available",
      desc: "See your meetings for the days ahead alongside the club schedule.",
      can: ["Read only"], action: { label: "Set up in the portal", href: portal } },
    { id: "gdrive", name: "Google Drive", by: "Google Workspace", ico: "D", c: "#fbbf24", state: "available",
      desc: "Search and read your Docs, Sheets and Slides.",
      can: ["Search", "Read only"], action: { label: "Set up in the portal", href: portal } },
    { id: "sheets", name: "Google Sheets (edit)", by: "Google Workspace", ico: "S", c: "#34d399", state: "soon",
      desc: "Fill in and update sheets such as trackers and greensheets.", can: ["Write"] },
    { id: "slack", name: "Slack", by: "Messaging", ico: "#", c: "#c084fc", state: "soon",
      desc: "Get your morning brief as a message and ask questions from a channel.", can: ["Messages"] },
    { id: "gymsales", name: "GymSales", by: "Sales", ico: "G", c: "#fb923c", state: "soon",
      desc: "Live leads and tours, beyond the daily calendar copy.", can: ["Leads", "Tours"] },
    { id: "paychex", name: "Paychex", by: "Payroll (admins)", ico: "P", c: "#38bdf8", state: "soon",
      desc: "Hours and checks for payroll questions, read only.", can: ["Read only"] },
    { id: "sms", name: "Text messages", by: "Messaging", ico: "✉", c: "#f472b6", state: "soon",
      desc: "Draft follow-up texts for call lists. You approve every one.", can: ["Draft only"] }
  ];
  var LABEL = { on: "Connected", available: "Available", soon: "Coming soon" };
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; }
  function disconnect(btn) {
    if (!confirm("Disconnect your " + svc + " sign-in from your ECA agent? Your chats and files stay.")) return;
    btn.disabled = true;
    fetch("/_eca/disconnect-ai", { method: "POST", credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { alert("Could not disconnect. Reload and try again."); btn.disabled = false; return; }
        if (d.revoke_note) alert(d.revoke_note);
        location.reload();
      });
  }
  var grid = document.getElementById("grid"), empty = document.getElementById("empty");
  var filter = "all", query = "";
  function draw() {
    grid.textContent = "";
    var shown = 0;
    ITEMS.forEach(function (it, i) {
      if (filter !== "all" && it.state !== filter) return;
      if (query && (it.name + " " + it.by + " " + it.desc).toLowerCase().indexOf(query) < 0) return;
      shown++;
      var card = el("article", "card"); card.style.animationDelay = (shown * 30) + "ms";
      var head = el("div", "head");
      var ico = el("div", "ico", it.ico); ico.style.setProperty("--c", it.c); head.appendChild(ico);
      var t = el("div"); t.appendChild(el("div", "name", it.name)); t.appendChild(el("div", "by", it.by)); head.appendChild(t);
      head.appendChild(el("span", "pill " + it.state, LABEL[it.state]));
      card.appendChild(head);
      card.appendChild(el("p", "desc", it.desc));
      var can = el("ul", "can"); (it.can || []).forEach(function (c) { can.appendChild(el("li", "", c)); }); card.appendChild(can);
      var foot = el("div", "foot");
      var a = it.action;
      if (a && a.href) { var l = el("a", "btn" + (a.ghost ? " ghost" : ""), a.label); l.href = a.href; l.rel = "noreferrer"; foot.appendChild(l); }
      else if (a) { var b = el("button", "btn" + (a.ghost || a.disabled ? " ghost" : ""), a.label); b.type = "button";
        if (a.disabled) b.disabled = true; if (a.run) b.addEventListener("click", function () { a.run(b); }); foot.appendChild(b); }
      else foot.appendChild(el("span", "note", "Not available yet"));
      card.appendChild(foot);
      grid.appendChild(card);
    });
    empty.hidden = shown > 0;
  }
  document.getElementById("q").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); draw(); });
  document.getElementById("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    filter = b.dataset.f;
    [].forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
    draw();
  });
  draw();
})();

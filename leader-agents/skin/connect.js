// "Connect Claude": shows Claude's own sign-in program in a terminal box and
// carries keystrokes to it. Nothing here reads or keeps what is typed.
(function () {
  var main = document.querySelector("main");
  var term = new Terminal({
    cols: Number(main.dataset.cols), rows: Number(main.dataset.rows), fontSize: 13, cursorBlink: true,
    scrollback: 200, theme: { background: "#000000", foreground: "#e6f4ec", cursor: "#34d399" }
  });
  term.open(document.getElementById("t"));
  var openBtn = document.getElementById("open"), wait = document.getElementById("wait"), msg = document.getElementById("msg");
  var pasteBtn = document.getElementById("paste");
  var link = "", text = "", es = null, finished = false;
  var ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
  var OSC = new RegExp(ESC + "\\][^" + BEL + ESC + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g");
  var CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");

  term.onData(function (d) { send(d); });

  function findLink() {
    if (link) return;
    var found = text.replace(OSC, "").replace(CSI, "").match(/https:\/\/[^\s"'<>]+/g) || [];
    for (var i = 0; i < found.length; i++) {
      try {
        var host = new URL(found[i]).hostname;
        // Only Anthropic's own addresses are ever opened from here.
        if (/(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(host)) {
          link = found[i]; openBtn.disabled = false; wait.textContent = "Opens in a new tab."; return;
        }
      } catch (e) {}
    }
  }
  function send(d) {
    return fetch("/_eca/connect/input", { method: "POST", credentials: "same-origin", body: d }).catch(function () {});
  }
  openBtn.addEventListener("click", function () {
    if (!link) return;
    window.open(link, "_blank", "noopener,noreferrer");
    pasteBtn.disabled = false;
    term.focus();
  });
  // Types what is on the clipboard into Claude's program, exactly as a paste in
  // the box would, then presses Enter. The code is not kept anywhere here.
  pasteBtn.addEventListener("click", function () {
    msg.textContent = "";
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      msg.textContent = "Click inside the box below, paste the code and press Enter."; term.focus(); return;
    }
    navigator.clipboard.readText().then(function (code) {
      code = (code || "").trim();
      if (!code || code.length > 600 || /\s/.test(code)) {
        msg.textContent = "That does not look like the code. Press Copy on Claude's page, then try again."; return;
      }
      send(code + "\r"); term.focus();
    }).catch(function () {
      msg.textContent = "Your browser did not allow reading the clipboard. Click inside the box below, paste the code and press Enter.";
      term.focus();
    });
  });
  window.addEventListener("focus", function () { if (!finished) term.focus(); });

  function feed(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    term.write(bytes);
    text = (text + new TextDecoder().decode(bytes)).slice(-20000);
    findLink();
  }

  // fresh: start a new sign-in even if one is running (used after one has ended).
  function begin(fresh) {
    msg.textContent = ""; link = ""; text = ""; openBtn.disabled = true; pasteBtn.disabled = true;
    wait.textContent = "Getting your link…";
    term.reset();
    return fetch("/_eca/connect/start", { method: "POST", credentials: "same-origin", body: fresh ? "fresh" : "" }).then(function (r) {
      if (!r.ok) { msg.textContent = "Could not start the sign-in. Reload this page to try again."; return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      // Coming back to a sign-in already under way: the code can be pasted straight away.
      if (d.resumed) pasteBtn.disabled = false;
      if (es) es.close();
      es = new EventSource("/_eca/connect/stream");
      es.onmessage = function (e) { feed(e.data); };
      es.addEventListener("end", function () { es.close(); if (!finished) check(true); });
      term.focus();
    });
  }

  var restarts = 0;
  function check(ended) {
    fetch("/_eca/whoami", { cache: "no-store", credentials: "same-origin" }).then(function (r) {
      if (r.status === 401) { location.replace("/_eca/signed-out"); return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      if (d.claude_signed_in === true) {
        finished = true; if (es) es.close();
        document.getElementById("steps").style.display = "none";
        document.getElementById("ok").style.display = "block";
        setTimeout(function () { location.replace("/_eca/open"); }, 1200);
        return;
      }
      if (ended) {
        if (++restarts > 3) { msg.textContent = "The sign-in keeps closing. Reload this page to try again."; return; }
        msg.textContent = "The sign-in closed before it finished. Starting it again…";
        setTimeout(function () { begin(true); }, 1500);
        return;
      }
      if (!finished) setTimeout(check, 3000);
    }).catch(function () { if (!finished && !ended) setTimeout(check, 3000); });
  }

  begin(false).then(function () { setTimeout(check, 4000); });
})();

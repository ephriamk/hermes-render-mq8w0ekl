// "Connect Claude" / "Connect ChatGPT": shows the service's own sign-in program in a
// terminal box (folded away unless needed) and carries keystrokes to it. Nothing here
// reads or keeps what is typed; the one-time code is only copied for the person.
(function () {
  var main = document.querySelector("main");
  var codex = main.dataset.engine === "codex";
  var $ = function (id) { return document.getElementById(id); };
  var openBtn = $("open"), pasteBtn = $("paste"), copyBtn = $("copy"), codeEl = $("code");
  var wait = $("wait"), msg = $("msg"), prog = $("prog");

  // Initials for the person chip.
  (function () {
    var parts = ($("who").textContent || "").replace(/,/g, " ").trim().split(/\s+/);
    $("av").textContent = (((parts[0] || "")[0] || "") + ((parts.length > 1 ? parts[parts.length - 1][0] : "") || "")).toUpperCase();
  })();

  var term = new Terminal({
    cols: Number(main.dataset.cols), rows: Number(main.dataset.rows), fontSize: 13, cursorBlink: true,
    scrollback: 200, theme: { background: "#000000", foreground: "#e6f4ec", cursor: "#7ed957" }
  });
  term.open($("t"));
  term.onData(function (d) { send(d); });

  // Only the sign-in service's own addresses are ever opened from here.
  var HOSTS = codex ? /(^|\.)(openai\.com|chatgpt\.com)$/ : /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/;
  var link = "", code = "", text = "", es = null, finished = false;
  var ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
  var OSC = new RegExp(ESC + "\\][^" + BEL + ESC + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g");
  var CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");

  function step(n, waiting) {
    for (var i = 1; i <= 3; i++) {
      var s = $("s" + i);
      s.classList.toggle("done", i < n);
      s.classList.toggle("active", i === n);
      s.classList.toggle("waiting", i === n && !!waiting);
    }
  }
  function showCode(c) {
    codeEl.textContent = "";
    for (var i = 0; i < c.length; i++) {
      var sp = document.createElement("span");
      if (c[i] === "-") sp.className = "dash";
      sp.textContent = c[i];
      codeEl.appendChild(sp);
    }
  }
  function send(d) {
    return fetch("/_eca/connect/input", { method: "POST", credentials: "same-origin", body: d }).catch(function () {});
  }

  function scan() {
    var plain = text.replace(OSC, "").replace(CSI, "");
    if (codex && !code) {
      var m = plain.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/);
      if (m) { code = m[1]; showCode(code); copyBtn.disabled = false; }
    }
    if (!link) {
      var found = plain.match(/https:\/\/[^\s"'<>]+/g) || [];
      for (var i = 0; i < found.length; i++) {
        try { if (HOSTS.test(new URL(found[i]).hostname)) { link = found[i]; break; } } catch (e) {}
      }
      if (link) openBtn.disabled = false;
    }
    if (codex) {
      if (code && link && $("s1").classList.contains("active")) { wait.textContent = "Ready. Copy it, then go to step 2."; step(1); }
    } else if (link && $("s1").classList.contains("waiting")) {
      wait.textContent = "Opens in a new tab."; step(1);
    }
  }

  if (copyBtn) copyBtn.addEventListener("click", function () {
    if (!code) return;
    var done = function () { copyBtn.textContent = "Copied ✓"; step(2); setTimeout(function () { copyBtn.textContent = "Copy"; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
    else done();
  });

  openBtn.addEventListener("click", function () {
    if (!link) return;
    window.open(link, "_blank", "noopener,noreferrer");
    if (codex) step(3, true);
    else { pasteBtn.disabled = false; step(2, true); }
    if (!codex) term.focus();
  });

  if (pasteBtn) pasteBtn.addEventListener("click", function () {
    msg.textContent = "";
    var manual = function (why) {
      msg.textContent = why + " Open the box below, click inside it, paste (Ctrl+V or ⌘V) and press Enter.";
      prog.open = true; term.focus();
    };
    if (!navigator.clipboard || !navigator.clipboard.readText) return manual("This browser can't read the clipboard from here.");
    navigator.clipboard.readText().then(function (c) {
      c = (c || "").trim();
      if (!c || c.length > 600 || /\s/.test(c)) {
        msg.textContent = "That doesn't look like Claude's code. Press Copy on Claude's page, then try again."; return;
      }
      send(c + "\r"); step(3, true);
    }).catch(function () { manual("Your browser didn't allow reading the clipboard."); });
  });

  function feed(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    term.write(bytes);
    text = (text + new TextDecoder().decode(bytes)).slice(-20000);
    scan();
  }

  // fresh: start a new sign-in even if one is running (used after one has ended).
  function begin(fresh) {
    msg.textContent = ""; link = ""; code = ""; text = "";
    openBtn.disabled = true; if (pasteBtn) pasteBtn.disabled = true; if (copyBtn) copyBtn.disabled = true;
    if (codeEl) codeEl.innerHTML = '<div class="skeleton"></div>';
    wait.textContent = codex ? "Getting your code…" : "Getting your link…";
    step(1, true);
    term.reset();
    return fetch("/_eca/connect/start", { method: "POST", credentials: "same-origin", body: fresh ? "fresh" : "" }).then(function (r) {
      if (!r.ok) { msg.textContent = "Could not start the sign-in. Reload this page to try again."; return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      // Coming back to a Claude sign-in already under way: the code can be pasted straight away.
      if (d.resumed && pasteBtn) pasteBtn.disabled = false;
      if (es) es.close();
      es = new EventSource("/_eca/connect/stream");
      es.onmessage = function (e) { feed(e.data); };
      es.addEventListener("end", function () { es.close(); if (!finished) check(true); });
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
        main.classList.add("finished");
        setTimeout(function () { location.replace("/_eca/open"); }, 1400);
        return;
      }
      if (ended) {
        if (++restarts > 3) { msg.textContent = "The sign-in keeps closing. Reload this page to try again."; return; }
        msg.textContent = "The sign-in closed before it finished. Starting a fresh one…";
        setTimeout(function () { begin(true); }, 1500);
        return;
      }
      if (!finished) setTimeout(check, 3000);
    }).catch(function () { if (!finished && !ended) setTimeout(check, 3000); });
  }

  begin(false).then(function () { setTimeout(check, 4000); });
})();

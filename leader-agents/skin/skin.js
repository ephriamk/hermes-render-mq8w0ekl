// ECA naming for the workspace tab.
(function () {
  var want = "ECA Agent";
  function fix() { if (document.title !== want) document.title = want; }
  fix();
  try { new MutationObserver(fix).observe(document.querySelector("title") || document.head, { childList: true, subtree: true, characterData: true }); } catch (e) {}
})();

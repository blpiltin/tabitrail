// Placeholder for a tab restored by Tabitrail. It costs almost nothing and makes no network request:
// the real page is only loaded once the user actually looks at this tab.
(function () {
  const params = new URLSearchParams(location.search);
  const target = params.get('u') || '';
  const title = params.get('t') || target;
  document.title = title;
  document.getElementById('title').textContent = title;
  const link = document.getElementById('url');
  link.textContent = target;

  if (!/^https?:\/\//i.test(target)) {
    document.getElementById('msg').textContent = "This link can't be opened.";
    return;
  }
  link.href = target;

  let started = false;
  function go() {
    if (started) return;
    started = true;
    location.replace(target); // replace, so Back doesn't land on the placeholder
  }
  // A background window's active tab is "visible" but not focused, so require focus too.
  function maybeGo() {
    if (document.visibilityState === 'visible' && document.hasFocus()) go();
  }
  document.addEventListener('visibilitychange', maybeGo);
  window.addEventListener('focus', maybeGo);
  maybeGo();
})();

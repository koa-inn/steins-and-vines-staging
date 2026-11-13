/* Phase 99 perf harness seed. Served ONLY by tests/perf/server.mjs (injected into
 * the served brewpad.html at request time). Not part of the shipped site. ES5. */
(function () {
  var origin = location.origin;
  var params = new URLSearchParams(location.search);
  var warm = params.get('warm') === '1';
  try {
    var now = Date.now();
    localStorage.setItem('sv-brewpad-session', JSON.stringify({
      email: 'harness@example.test',
      token: 'harness-token',
      expires_at: now + 8 * 3600 * 1000,
      login_at: now
    }));
    localStorage.setItem('sv_session_token', 'harness-session');
    localStorage.setItem('bp_dash_v2', '1');
    localStorage.setItem('bp_dash_default_v2', '1');
    if (!warm) {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('bp_dash_cache') === 0) drop.push(k);
      }
      for (var j = 0; j < drop.length; j++) localStorage.removeItem(drop[j]);
    }
  } catch (e) { /* storage unavailable */ }

  // Belt and braces: even if the sheets-config rewrite is missed, no request may
  // leave this origin for the real middleware or Google.
  var realFetch = window.fetch;
  function blockedHost(host) {
    return /\.up\.railway\.app$/.test(host) || host === 'www.googleapis.com' ||
      host === 'accounts.google.com' || host === 'script.google.com' ||
      /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(host);
  }
  window.fetch = function (input, init) {
    try {
      var url = new URL(typeof input === 'string' ? input : (input && input.url) || '', origin);
      if (url.origin !== origin && blockedHost(url.hostname)) {
        if (url.hostname === 'www.googleapis.com') {
          return Promise.resolve(new Response(JSON.stringify({ email: 'harness@example.test' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          }));
        }
        return Promise.reject(new TypeError('harness: blocked external request to ' + url.hostname));
      }
    } catch (e) { /* fall through to real fetch (same-origin) */ }
    return realFetch.call(window, input, init);
  };
})();

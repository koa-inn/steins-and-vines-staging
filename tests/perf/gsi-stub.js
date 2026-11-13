/* Phase 99 perf harness stand-in for https://accounts.google.com/gsi/client.
 * Served ONLY by tests/perf/server.mjs. ES5. */
window.google = window.google || {};
window.google.accounts = window.google.accounts || {};
window.google.accounts.oauth2 = {
  initTokenClient: function () {
    return { requestAccessToken: function () {} };
  },
  revoke: function () {}
};

// ===== Steins & Vines — Shared Google Auth Primitives =====
// Canonical implementations of the shared Google Identity Services helpers.
// Load this script before any page-specific JS that uses Google OAuth.
//
// What lives here:
//   - waitForGoogleIdentity(onReady)   — polls until google.accounts.oauth2 is available
//   - gsiInitTokenClient(opts)         — thin wrapper around google.accounts.oauth2.initTokenClient
//   - fetchGoogleUserInfo(token)        — fetches /oauth2/v3/userinfo, returns Promise<{email, ...}>
//
// What does NOT live here:
//   - initGoogleAuth()       — page-specific: different DOM elements, session retry logic, timeouts
//   - onTokenResponse()      — page-specific: different error paths (admin/kiosk vs brewpad)
//   - saveSession/loadSession — page-specific: different localStorage keys and data shapes
//   - Token refresh timers   — page-specific: started at different points in each page's auth flow
//   - showSignInButton()     — page-specific: different container element IDs

// ---------------------------------------------------------------------------
// waitForGoogleIdentity(onReady)
// ---------------------------------------------------------------------------
// Polls every 100 ms until the Google Identity Services library is loaded,
// then calls onReady().  Identical across admin.js, kiosk.js, and brewpad.js.
//
// @param {Function} onReady  Called (with no arguments) once google.accounts.oauth2 is available.

function waitForGoogleIdentity(onReady) {
  if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    onReady();
  } else {
    setTimeout(function () { waitForGoogleIdentity(onReady); }, 100);
  }
}

// ---------------------------------------------------------------------------
// gsiInitTokenClient(opts)
// ---------------------------------------------------------------------------
// Thin wrapper so pages don't repeat the google.accounts.oauth2.initTokenClient
// call shape.  opts must include { client_id, scope, callback }.
//
// @param  {Object} opts   Passed directly to google.accounts.oauth2.initTokenClient.
// @return {Object}        The token client handle returned by GIS.

function gsiInitTokenClient(opts) {
  return google.accounts.oauth2.initTokenClient(opts);
}

// ---------------------------------------------------------------------------
// fetchGoogleUserInfo(token)
// ---------------------------------------------------------------------------
// Fetches the Google userinfo endpoint and returns a Promise that resolves to
// the JSON body ({ email, sub, name, ... }).
// Identical across admin.js, kiosk.js, and brewpad.js.
//
// @param  {string}  token  A valid OAuth2 access token with userinfo.email scope.
// @return {Promise<Object>}

function fetchGoogleUserInfo(token) {
  return fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token }
  }).then(function (res) { return res.json(); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    waitForGoogleIdentity: waitForGoogleIdentity,
    gsiInitTokenClient: gsiInitTokenClient,
    fetchGoogleUserInfo: fetchGoogleUserInfo
  };
}

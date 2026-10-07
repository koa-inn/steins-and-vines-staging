'use strict';

/**
 * Single source for the browser Origin allowlist (CORS in server.js and the
 * Origin check on the Staff Access routes, Phase 86 D-02).
 */

var ALLOWED_ORIGINS = [
  'https://steinsandvines.ca',
  'https://staging.steinsandvines.ca',
  'http://localhost:3001',
  'http://localhost:8080'
];

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

module.exports = {
  ALLOWED_ORIGINS: ALLOWED_ORIGINS,
  isAllowedOrigin: isAllowedOrigin
};

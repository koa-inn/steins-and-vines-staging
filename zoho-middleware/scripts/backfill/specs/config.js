/**
 * Config sheet -> config table spec (Phase 86 Plan 09, DB-05). Two columns: key, value.
 * Not registered in specs/index.js (see vessels.js). `value` is optional here; the planner
 * requires it for the keys it actually imports.
 */
'use strict';

module.exports = {
  sheet: 'Config',
  table: 'config',
  primaryKey: 'key',
  columns: [
    { name: 'key', header: 'key', type: 'text', required: true, pgType: 'text' },
    { name: 'value', header: 'value', type: 'text', required: false, pgType: 'text' }
  ]
};

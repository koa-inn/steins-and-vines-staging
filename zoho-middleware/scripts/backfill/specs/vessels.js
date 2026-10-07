/**
 * Vessels sheet -> vessels table spec (Phase 86 Plan 09, DB-05).
 *
 * Deliberately NOT registered in specs/index.js: the only route in is the dedicated
 * ops-backfill.js CLI (four-table job: position derived from sheet row order, archived
 * derived from status, staff_access seeded from outside the workbook).
 *
 * The live sheet has 11 headed columns of 28 physical ones; unheaded columns are never read.
 * optionalHeaders lists the single extra header the owner may add before production dual
 * (decision 2026-10-07: 'label'). It is header-addressed, never positional, and is not part
 * of `columns` (the pinned real header list); ops-backfill.js reads it separately.
 * `position`, `archived`, `created_*`, `updated_*` are not sheet columns.
 */
'use strict';

function txt(name, required) {
  return { name: name, header: name, type: 'text', required: !!required, pgType: 'text' };
}

function num(name) {
  return { name: name, header: name, type: 'numeric', required: false, pgType: 'numeric', scale: 6 };
}

module.exports = {
  sheet: 'Vessels',
  table: 'vessels',
  primaryKey: 'vessel_id',
  optionalHeaders: ['label'],
  columns: [
    { name: 'vessel_id', header: 'vessel_id', type: 'id', required: true, pgType: 'text' },
    txt('type', true),
    txt('material', false),
    num('capacity_liters'),
    txt('status', true),
    num('bottom_diameter_cm'),
    num('top_diameter_cm'),
    num('depth_cm'),
    txt('location', false),
    txt('brand', false),
    txt('notes', false)
  ]
};

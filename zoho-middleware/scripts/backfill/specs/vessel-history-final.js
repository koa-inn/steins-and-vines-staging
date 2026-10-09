/**
 * Final spec: VesselHistory sheet -> vessel_history table (Phase 87, DB-06).
 * Distinct from the Phase 83 rehearsal spec (vessel-history.js): names equal the DDL columns
 * (history_id, transferred_at, transferred_by, notes). 8 real headers, pinned by
 * batches-spec-headers.test.js. bin_id is a number cell in the sheet, kept as text.
 */
'use strict';

module.exports = {
  sheet: 'VesselHistory',
  table: 'vessel_history',
  primaryKey: 'history_id',
  columns: [
    { name: 'history_id', header: 'history_id', type: 'id', required: true },
    { name: 'batch_id', header: 'batch_id', type: 'id', required: true },
    { name: 'vessel_id', header: 'vessel_id', type: 'text', required: false },
    { name: 'shelf_id', header: 'shelf_id', type: 'text', required: false },
    { name: 'bin_id', header: 'bin_id', type: 'text', required: false },
    { name: 'transferred_at', header: 'transferred_at', type: 'timestamptz', required: true },
    { name: 'transferred_by', header: 'transferred_by', type: 'text', required: false },
    { name: 'notes', header: 'notes', type: 'text', required: false }
  ]
};

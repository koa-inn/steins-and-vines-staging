/**
 * Final spec: PlatoReadings sheet -> plato_readings table (Phase 87, DB-06).
 * Distinct from the Phase 83 rehearsal spec (plato-readings.js, numeric(5,2) scratch columns):
 * the real table has unconstrained numerics and the DDL column reading_at, fed by the sheet
 * header `timestamp`. 9 real headers, pinned by batches-spec-headers.test.js.
 */
'use strict';

module.exports = {
  sheet: 'PlatoReadings',
  table: 'plato_readings',
  primaryKey: 'reading_id',
  columns: [
    { name: 'reading_id', header: 'reading_id', type: 'id', required: true },
    { name: 'batch_id', header: 'batch_id', type: 'id', required: true },
    { name: 'reading_at', header: 'timestamp', type: 'timestamptz', required: true },
    { name: 'degrees_plato', header: 'degrees_plato', type: 'number', required: false },
    { name: 'notes', header: 'notes', type: 'text', required: false },
    { name: 'recorded_by', header: 'recorded_by', type: 'text', required: false },
    // Never default created_at to now(): fabricating a timestamp is coercion.
    { name: 'created_at', header: 'created_at', type: 'timestamptz', required: true },
    { name: 'temperature', header: 'temperature', type: 'number', required: false },
    { name: 'ph', header: 'ph', type: 'number', required: false }
  ]
};

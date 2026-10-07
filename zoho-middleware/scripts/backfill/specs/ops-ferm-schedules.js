/**
 * FermSchedules sheet -> ferm_schedules table spec for the Phase 86 ops backfill (DB-05).
 *
 * Copied from ferm-schedules.js (the Phase 83 rehearsal spec, left untouched) with the final
 * DDL column name `is_active` and an id pattern of ^FS-[0-9]{4,}$ (the planner enforces it;
 * pad:4 exact would reject FS-10000). Not registered in specs/index.js.
 */
'use strict';

module.exports = {
  sheet: 'FermSchedules',
  table: 'ferm_schedules',
  primaryKey: 'schedule_id',
  columns: [
    { name: 'schedule_id', header: 'schedule_id', type: 'id', required: true, pgType: 'text' },
    { name: 'name', header: 'name', type: 'text', required: true, pgType: 'text' },
    { name: 'description', header: 'description', type: 'text', required: false, pgType: 'text' },
    { name: 'category', header: 'category', type: 'text', required: false, pgType: 'text' },
    // JSON string in the sheet; parsed by normalizeRow, then validated by ferm-schedule-rules.
    { name: 'steps', header: 'steps', type: 'jsonb', required: true, pgType: 'jsonb' },
    { name: 'is_active', header: 'is_active', type: 'boolean', required: true, pgType: 'boolean' },
    { name: 'created_at', header: 'created_at', type: 'timestamptz', required: true, pgType: 'timestamptz' },
    { name: 'created_by', header: 'created_by', type: 'text', required: false, pgType: 'text' },
    { name: 'updated_at', header: 'last_updated', type: 'timestamptz', required: true, pgType: 'timestamptz' }
  ]
};

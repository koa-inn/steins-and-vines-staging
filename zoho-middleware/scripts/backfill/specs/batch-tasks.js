/**
 * Final spec: BatchTasks sheet -> batch_tasks table (Phase 87, DB-06).
 * 14 real headers, pinned by __tests__/backfill/batches-spec-headers.test.js; names equal the
 * DDL columns in 0005_batches.sql. Not registered in specs/index.js.
 * boolean: real booleans or TRUE/FALSE text; blank -> false. integer: whole numbers only.
 */
'use strict';

module.exports = {
  sheet: 'BatchTasks',
  table: 'batch_tasks',
  primaryKey: 'task_id',
  columns: [
    { name: 'task_id', header: 'task_id', type: 'id', required: true },
    { name: 'batch_id', header: 'batch_id', type: 'id', required: true },
    { name: 'step_number', header: 'step_number', type: 'integer', required: true },
    { name: 'title', header: 'title', type: 'text', required: false },
    { name: 'description', header: 'description', type: 'text', required: false },
    { name: 'day_offset', header: 'day_offset', type: 'integer', required: true },
    { name: 'due_date', header: 'due_date', type: 'date', required: false },
    { name: 'is_packaging', header: 'is_packaging', type: 'boolean', required: false },
    { name: 'is_transfer', header: 'is_transfer', type: 'boolean', required: false },
    { name: 'completed', header: 'completed', type: 'boolean', required: false },
    { name: 'completed_at', header: 'completed_at', type: 'timestamptz', required: false },
    { name: 'completed_by', header: 'completed_by', type: 'text', required: false },
    { name: 'notes', header: 'notes', type: 'text', required: false },
    { name: 'last_updated', header: 'last_updated', type: 'timestamptz', required: true }
  ]
};

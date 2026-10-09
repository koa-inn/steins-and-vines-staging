/**
 * Final spec: Batches sheet -> batches table (Phase 87, DB-06).
 * `header` is the sheet's real row-1 text (33 columns, pinned by
 * __tests__/backfill/batches-spec-headers.test.js); `name` is the DDL column in 0005_batches.sql.
 * They differ only for target_volume_L -> target_volume_l. Not registered in specs/index.js
 * (dedicated multi-table CLI, same precedent as the Phase 86 ops specs).
 *
 * Column types here are backfill types, not Postgres types:
 *   id, text (blank -> ''), nullable_text (blank -> null, FK columns), date (blank -> null),
 *   timestamptz (blank -> null unless required), number (unconstrained numeric kept as text,
 *   blank -> null).
 * unit_seq is derived by the plan builder, not read from the sheet.
 */
'use strict';

module.exports = {
  sheet: 'Batches',
  table: 'batches',
  primaryKey: 'batch_id',
  columns: [
    { name: 'batch_id', header: 'batch_id', type: 'id', required: true },
    { name: 'status', header: 'status', type: 'text', required: true },
    { name: 'product_sku', header: 'product_sku', type: 'text', required: false },
    { name: 'product_name', header: 'product_name', type: 'text', required: false },
    { name: 'customer_id', header: 'customer_id', type: 'text', required: false },
    { name: 'customer_name', header: 'customer_name', type: 'text', required: false },
    { name: 'customer_email', header: 'customer_email', type: 'text', required: false },
    { name: 'start_date', header: 'start_date', type: 'date', required: false },
    { name: 'schedule_id', header: 'schedule_id', type: 'nullable_text', required: false },
    { name: 'schedule_snapshot', header: 'schedule_snapshot', type: 'text', required: false },
    { name: 'vessel_id', header: 'vessel_id', type: 'text', required: false },
    { name: 'shelf_id', header: 'shelf_id', type: 'text', required: false },
    // bin_id cells are numbers in the sheet but are labels; kept as text.
    { name: 'bin_id', header: 'bin_id', type: 'text', required: false },
    { name: 'notes', header: 'notes', type: 'text', required: false },
    { name: 'access_token', header: 'access_token', type: 'text', required: true },
    { name: 'reservation_id', header: 'reservation_id', type: 'text', required: false },
    { name: 'created_at', header: 'created_at', type: 'timestamptz', required: true },
    { name: 'created_by', header: 'created_by', type: 'text', required: false },
    { name: 'last_updated', header: 'last_updated', type: 'timestamptz', required: true },
    { name: 'last_regenerated_at', header: 'last_regenerated_at', type: 'timestamptz', required: false },
    { name: 'source', header: 'source', type: 'text', required: false },
    { name: 'zoho_so_number', header: 'zoho_so_number', type: 'text', required: false },
    { name: 'fermentation_started_at', header: 'fermentation_started_at', type: 'timestamptz', required: false },
    { name: 'completed_at', header: 'completed_at', type: 'timestamptz', required: false },
    { name: 'customer_firstname', header: 'customer_firstname', type: 'text', required: false },
    { name: 'customer_lastname', header: 'customer_lastname', type: 'text', required: false },
    { name: 'recipe_id', header: 'recipe_id', type: 'text', required: false },
    { name: 'customer_phone', header: 'customer_phone', type: 'text', required: false },
    { name: 'target_volume_l', header: 'target_volume_L', type: 'number', required: false },
    { name: 'scale_factor', header: 'scale_factor', type: 'number', required: false },
    { name: 'recipe_snapshot', header: 'recipe_snapshot', type: 'text', required: false },
    { name: 'bottling_invite_sent_at', header: 'bottling_invite_sent_at', type: 'timestamptz', required: false },
    { name: 'bottling_invite_email', header: 'bottling_invite_email', type: 'text', required: false }
  ]
};

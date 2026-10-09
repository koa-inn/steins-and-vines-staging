'use strict';

// Phase 87-03: synthetic Batches / BatchTasks / PlatoReadings / VesselHistory workbook.
// Invented data only (no real customers, emails or tokens). It exercises every
// response-shaping rule of the Apps Script batch reads:
//   all five statuses, pending batches (with and without a vessel), undated packaging tasks
//   on a ready and a not-ready batch, an undated non-packaging task, a duplicate
//   (batch_id, step_number) pair, numeric bin_id, Date-cell dates, blank numerics, a completed
//   transfer task, readings with and without temperature, history rows (including a same-day
//   pair), batches spread over 7 months, and an invoice+SKU pair on two batches (unit_total 2).
//
// Cell types follow what sheetToObjects sees in production: start_date / task due_date /
// reading timestamp are Date cells; the other timestamps are ISO strings; booleans are real
// booleans; bin_id is a number; blanks are ''.

var HEADERS = {
  Batches: [
    'batch_id', 'status', 'product_sku', 'product_name', 'customer_id', 'customer_name',
    'customer_email', 'start_date', 'schedule_id', 'schedule_snapshot', 'vessel_id', 'shelf_id',
    'bin_id', 'notes', 'access_token', 'reservation_id', 'created_at', 'created_by',
    'last_updated', 'last_regenerated_at', 'source', 'zoho_so_number', 'fermentation_started_at',
    'completed_at', 'customer_firstname', 'customer_lastname', 'recipe_id', 'customer_phone',
    'target_volume_L', 'scale_factor', 'recipe_snapshot', 'bottling_invite_sent_at',
    'bottling_invite_email'
  ],
  BatchTasks: [
    'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
    'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes',
    'last_updated'
  ],
  PlatoReadings: [
    'reading_id', 'batch_id', 'timestamp', 'degrees_plato', 'notes', 'recorded_by', 'created_at',
    'temperature', 'ph'
  ],
  VesselHistory: [
    'history_id', 'batch_id', 'vessel_id', 'shelf_id', 'bin_id', 'transferred_at',
    'transferred_by', 'notes'
  ]
};

// A sheet Date cell for a calendar day (Pacific midnight during DST).
function cell(ymd) { return new Date(ymd + 'T07:00:00.000Z'); }

function build(headers, obj) {
  return headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
}

var SNAPSHOT = JSON.stringify([
  { step_number: 1, title: 'Pitch yeast', day_offset: 0 },
  { step_number: 2, title: 'Rack', day_offset: 5, is_transfer: true },
  { step_number: 3, title: 'Package', day_offset: -1, is_packaging: true }
]);

var RECIPE_SNAPSHOT = JSON.stringify({ name: 'Test Recipe', target_volume_l: 23, scale_factor: 1.15 });

function tok(n) {
  var s = String(n);
  while (s.length < 32) s = 'a' + s;
  return s;
}

function batch(o) {
  var base = {
    product_sku: 'KIT-A', product_name: 'Test Style Red', customer_id: 'CUST-' + o.batch_id.slice(-3),
    customer_email: 'cust' + o.batch_id.slice(-3) + '@example.com', created_by: 'staff@example.com',
    source: 'manual', customer_phone: '555-0100', schedule_id: '', schedule_snapshot: ''
  };
  Object.keys(o).forEach(function (k) { base[k] = o[k]; });
  return build(HEADERS.Batches, base);
}

var BATCH_ROWS = [
  // primary, ready to bottle (all non-packaging done, undated packaging task)
  batch({ batch_id: 'SV-B-000001', status: 'primary', start_date: cell('2026-10-05'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-001', shelf_id: 'A', bin_id: 1, notes: 'Primary ready',
    access_token: tok(1), created_at: '2026-10-05T18:00:00.123Z', last_updated: '2026-10-10T16:30:00.456Z',
    customer_name: 'Test Customer A', customer_firstname: 'Test', customer_lastname: 'Customer A',
    fermentation_started_at: cell('2026-10-05'), recipe_id: 'RCP-000001', recipe_snapshot: RECIPE_SNAPSHOT,
    target_volume_L: 23, scale_factor: 1.15, zoho_so_number: 'INV-000100' }),
  // primary, NOT ready (non-packaging tasks open), duplicate step number, due today + this week
  batch({ batch_id: 'SV-B-000002', status: 'primary', start_date: cell('2026-09-20'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-002', shelf_id: 'B', bin_id: 12, notes: 'Primary busy',
    access_token: tok(2), created_at: '2026-09-20T17:00:00.000Z', last_updated: '2026-10-01T10:00:00.000Z',
    customer_name: 'Test Customer B', customer_firstname: 'Test', customer_lastname: 'Customer B',
    fermentation_started_at: '2026-09-20T17:00:00.000Z' }),
  // secondary with an overdue dated packaging task (ready by date)
  batch({ batch_id: 'SV-B-000003', status: 'secondary', start_date: cell('2026-09-01'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-003', shelf_id: 'C', bin_id: 3,
    access_token: tok(3), created_at: '2026-09-01T16:00:00.000Z', last_updated: '2026-09-28T09:00:00.000Z',
    customer_name: 'Test Customer C', customer_firstname: 'Test', customer_lastname: 'Customer C',
    fermentation_started_at: cell('2026-09-01') }),
  // secondary, no shelf or bin, undated non-packaging task and a task after the week window
  batch({ batch_id: 'SV-B-000004', status: 'secondary', start_date: cell('2026-08-20'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'CRB-004', shelf_id: '', bin_id: '',
    access_token: tok(4), created_at: '2026-08-20T15:00:00.000Z', last_updated: '2026-09-02T09:00:00.000Z',
    customer_name: 'Test Customer D', customer_firstname: 'Test', customer_lastname: 'Customer D',
    fermentation_started_at: '2026-08-20T15:00:00.000Z' }),
  // pending with a vessel but no schedule
  batch({ batch_id: 'SV-B-000005', status: 'pending', vessel_id: 'PCB-005', shelf_id: 'D', bin_id: 7,
    access_token: tok(5), created_at: '2026-10-06T12:00:00.000Z', last_updated: '2026-10-06T12:00:00.000Z',
    customer_name: 'Test Customer E', customer_firstname: 'Test', customer_lastname: 'Customer E',
    source: 'kiosk', customer_email: '', zoho_so_number: 'INV-000200', product_sku: 'KIT-A' }),
  // pending, no schedule or start, name only in first/last
  batch({ batch_id: 'SV-B-000006', status: 'pending',
    access_token: tok(6), created_at: '2026-10-09T12:00:00.000Z', last_updated: '2026-10-09T12:00:00.000Z',
    customer_name: '', customer_firstname: 'Test', customer_lastname: 'Customer F',
    source: 'kiosk', customer_email: '', zoho_so_number: 'INV-000200', product_sku: 'KIT-A' }),
  // complete
  batch({ batch_id: 'SV-B-000007', status: 'complete', start_date: cell('2026-05-10'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-001', shelf_id: 'A', bin_id: 1,
    access_token: tok(7), created_at: '2026-05-10T15:00:00.000Z', last_updated: '2026-07-01T09:00:00.000Z',
    customer_name: 'Test Customer G', customer_firstname: 'Test', customer_lastname: 'Customer G',
    completed_at: '2026-07-01T09:00:00.000Z', bottling_invite_sent_at: '2026-06-28T09:00:00.000Z',
    bottling_invite_email: 'cust007@example.com' }),
  // complete (April start: outside the six month window)
  batch({ batch_id: 'SV-B-000008', status: 'complete', start_date: cell('2026-04-02'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT,
    access_token: tok(8), created_at: '2026-04-02T15:00:00.000Z', last_updated: '2026-06-01T09:00:00.000Z',
    customer_name: 'Test Customer H', customer_firstname: 'Test', customer_lastname: 'Customer H',
    completed_at: '2026-06-01T09:00:00.000Z' }),
  // disabled
  batch({ batch_id: 'SV-B-000009', status: 'disabled', start_date: cell('2026-07-01'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-009', shelf_id: 'E', bin_id: 9,
    access_token: tok(9), created_at: '2026-07-01T15:00:00.000Z', last_updated: '2026-07-05T09:00:00.000Z',
    customer_name: 'Test Customer I', customer_firstname: 'Test', customer_lastname: 'Customer I' }),
  // primary whose packaging task is dated today, with an email on file
  batch({ batch_id: 'SV-B-000010', status: 'primary', start_date: cell('2026-10-08'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-010', shelf_id: 'F', bin_id: 10,
    access_token: tok(10), created_at: '2026-10-08T15:00:00.000Z', last_updated: '2026-10-08T15:00:00.000Z',
    customer_name: 'Test Customer J', customer_firstname: 'Test', customer_lastname: 'Customer J',
    zoho_so_number: 'INV-000300', product_sku: 'KIT-B' }),
  // invoice + SKU pair, unit 1 of 2
  batch({ batch_id: 'SV-B-000011', status: 'primary', start_date: cell('2026-06-15'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-011', shelf_id: 'A', bin_id: 11,
    access_token: tok(11), created_at: '2026-06-15T15:00:00.000Z', last_updated: '2026-06-15T15:00:00.000Z',
    customer_name: 'Test Customer K', customer_firstname: 'Test', customer_lastname: 'Customer K',
    zoho_so_number: 'INV-000400', product_sku: 'KIT-C' }),
  // invoice + SKU pair, unit 2 of 2
  batch({ batch_id: 'SV-B-000012', status: 'primary', start_date: cell('2026-06-15'), schedule_id: 'FS-000001',
    schedule_snapshot: SNAPSHOT, vessel_id: 'PCB-012', shelf_id: 'A', bin_id: 12,
    access_token: tok(12), created_at: '2026-06-15T15:00:01.000Z', last_updated: '2026-06-15T15:00:01.000Z',
    customer_name: 'Test Customer K', customer_firstname: 'Test', customer_lastname: 'Customer K',
    zoho_so_number: 'INV-000400', product_sku: 'KIT-C' }),
  // primary with no tasks at all (July start)
  batch({ batch_id: 'SV-B-000013', status: 'primary', start_date: cell('2026-07-20'),
    access_token: tok(13), created_at: '2026-07-20T15:00:00.000Z', last_updated: '2026-07-20T15:00:00.000Z',
    customer_name: 'Test Customer L', customer_firstname: 'Test', customer_lastname: 'Customer L' })
];

function task(o) {
  var base = {
    description: '', is_packaging: false, is_transfer: false, completed: false, completed_at: '',
    completed_by: '', notes: '', last_updated: '2026-10-01T10:00:00.000Z'
  };
  Object.keys(o).forEach(function (k) { base[k] = o[k]; });
  return build(HEADERS.BatchTasks, base);
}

var TASK_ROWS = [
  task({ task_id: 'BT-000001', batch_id: 'SV-B-000001', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-10-05'), completed: true, completed_at: '2026-10-05T18:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000002', batch_id: 'SV-B-000001', step_number: 2, title: 'Rack to secondary', day_offset: 5,
    due_date: cell('2026-10-10'), is_transfer: true, completed: true, completed_at: '2026-10-10T16:30:00.000Z',
    completed_by: 'staff@example.com', notes: 'Moved to shelf A' }),
  task({ task_id: 'BT-000003', batch_id: 'SV-B-000001', step_number: 3, title: 'Package', day_offset: -1,
    due_date: '', is_packaging: true }),
  task({ task_id: 'BT-000004', batch_id: 'SV-B-000002', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-09-20'), completed: true, completed_at: '2026-09-20T17:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000005', batch_id: 'SV-B-000002', step_number: 2, title: 'Add finings', day_offset: 21,
    due_date: cell('2026-10-11') }),
  task({ task_id: 'BT-000006', batch_id: 'SV-B-000002', step_number: 3, title: 'Cold crash', day_offset: 25,
    due_date: cell('2026-10-15'), description: 'Drop to 2C' }),
  task({ task_id: 'BT-000007', batch_id: 'SV-B-000002', step_number: 4, title: 'Package', day_offset: -1,
    due_date: '', is_packaging: true }),
  // duplicate (batch_id, step_number) pair with BT-000005
  task({ task_id: 'BT-000008', batch_id: 'SV-B-000002', step_number: 2, title: 'Check gravity', day_offset: 22,
    due_date: cell('2026-10-12') }),
  task({ task_id: 'BT-000009', batch_id: 'SV-B-000003', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-09-01'), completed: true, completed_at: '2026-09-01T16:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000010', batch_id: 'SV-B-000003', step_number: 2, title: 'Rack', day_offset: 34,
    due_date: cell('2026-10-05'), is_transfer: true }),
  task({ task_id: 'BT-000011', batch_id: 'SV-B-000003', step_number: 3, title: 'Package', day_offset: 40,
    due_date: cell('2026-10-10'), is_packaging: true }),
  // undated, non-packaging
  task({ task_id: 'BT-000012', batch_id: 'SV-B-000004', step_number: 1, title: 'Check airlock', day_offset: -1,
    due_date: '' }),
  task({ task_id: 'BT-000013', batch_id: 'SV-B-000004', step_number: 2, title: 'Bulk age', day_offset: 66,
    due_date: cell('2026-10-25') }),
  task({ task_id: 'BT-000014', batch_id: 'SV-B-000010', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-10-08'), completed: true, completed_at: '2026-10-08T15:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000015', batch_id: 'SV-B-000010', step_number: 2, title: 'Package', day_offset: 3,
    due_date: cell('2026-10-11'), is_packaging: true }),
  task({ task_id: 'BT-000016', batch_id: 'SV-B-000007', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-05-10'), completed: true, completed_at: '2026-05-10T15:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000017', batch_id: 'SV-B-000007', step_number: 2, title: 'Package', day_offset: 60,
    due_date: cell('2026-07-09'), is_packaging: true, completed: true, completed_at: '2026-07-01T09:00:00.000Z',
    completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000018', batch_id: 'SV-B-000009', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-07-01') }),
  task({ task_id: 'BT-000019', batch_id: 'SV-B-000011', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-06-15'), completed: true, completed_at: '2026-06-15T15:30:00.000Z', completed_by: 'staff@example.com' }),
  task({ task_id: 'BT-000020', batch_id: 'SV-B-000011', step_number: 2, title: 'Package', day_offset: -1,
    due_date: '', is_packaging: true }),
  task({ task_id: 'BT-000021', batch_id: 'SV-B-000012', step_number: 1, title: 'Pitch yeast', day_offset: 0,
    due_date: cell('2026-06-15') })
];

function reading(o) {
  var base = { notes: '', recorded_by: 'staff@example.com' };
  Object.keys(o).forEach(function (k) { base[k] = o[k]; });
  return build(HEADERS.PlatoReadings, base);
}

// Out of date order on purpose; one without a temperature, one without plato, one with ph.
var READING_ROWS = [
  reading({ reading_id: 'PR-000001', batch_id: 'SV-B-000001', timestamp: cell('2026-10-08'), degrees_plato: 14.5,
    created_at: '2026-10-08T20:00:00.000Z', temperature: 20 }),
  reading({ reading_id: 'PR-000002', batch_id: 'SV-B-000001', timestamp: cell('2026-10-06'), degrees_plato: 18,
    created_at: '2026-10-06T20:00:00.000Z', temperature: '', notes: 'Day one' }),
  reading({ reading_id: 'PR-000003', batch_id: 'SV-B-000001', timestamp: cell('2026-10-10'), degrees_plato: '',
    created_at: '2026-10-10T20:00:00.000Z', temperature: 19, ph: 3.4, recorded_by: 'batch-url' }),
  reading({ reading_id: 'PR-000004', batch_id: 'SV-B-000002', timestamp: cell('2026-10-01'), degrees_plato: 9.25,
    created_at: '2026-10-01T20:00:00.000Z', temperature: 21.5 })
];

function history(o) {
  var base = { transferred_by: 'staff@example.com', notes: '' };
  Object.keys(o).forEach(function (k) { base[k] = o[k]; });
  return build(HEADERS.VesselHistory, base);
}

var HISTORY_ROWS = [
  history({ history_id: 'VH-000001', batch_id: 'SV-B-000001', vessel_id: 'PCB-001', shelf_id: 'A', bin_id: 1,
    transferred_at: '2026-10-05T18:00:00.000Z', notes: 'Initial placement' }),
  history({ history_id: 'VH-000002', batch_id: 'SV-B-000001', vessel_id: 'PCB-009', shelf_id: 'E', bin_id: 2,
    transferred_at: '2026-10-10T16:30:00.000Z', notes: 'Moved for racking' }),
  // same calendar day: the 10 char truncation makes these tie
  history({ history_id: 'VH-000003', batch_id: 'SV-B-000003', vessel_id: 'PCB-003', shelf_id: 'C', bin_id: 3,
    transferred_at: '2026-09-01T16:00:00.000Z', notes: 'Initial placement' }),
  history({ history_id: 'VH-000004', batch_id: 'SV-B-000003', vessel_id: 'PCB-003', shelf_id: 'C', bin_id: 4,
    transferred_at: '2026-09-01T19:00:00.000Z', notes: 'Shelf adjust' }),
  history({ history_id: 'VH-000005', batch_id: 'SV-B-000002', vessel_id: 'PCB-002', shelf_id: 'B', bin_id: 12,
    transferred_at: '2026-09-20T17:00:00.000Z', notes: 'Initial placement' })
];

module.exports = {
  headers: HEADERS,
  rows: {
    Batches: BATCH_ROWS,
    BatchTasks: TASK_ROWS,
    PlatoReadings: READING_ROWS,
    VesselHistory: HISTORY_ROWS
  },
  now: '2026-10-11T19:30:00.000Z',
  timezone: 'America/Vancouver'
};

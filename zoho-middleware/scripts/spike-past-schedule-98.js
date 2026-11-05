#!/usr/bin/env node
/**
 * spike-past-schedule-98.js - READ-ONLY dev tool (Phase 98, D-09/D-10 assumption check).
 * SELECT only; no writes; prints counts and batch_ids only.
 *
 * Compares planned_days (max batch_tasks.day_offset, used by the dashboard)
 * with the max day_offset in each batch's own schedule_snapshot (D-10), and
 * counts active batches past plan (+0 / +7 / +14 days).
 *
 * USAGE (inside the production container, cwd = app dir containing lib/db.js):
 *   node - --run < scripts/spike-past-schedule-98.js
 */

'use strict';

var path = require('path');

var SQL =
  "select b.batch_id, b.status, to_char(b.start_date, 'YYYY-MM-DD') as start_date, " +
  'b.schedule_snapshot, ' +
  '(select max(t.day_offset) from batch_tasks t where t.batch_id = b.batch_id) as planned_days ' +
  "from batches b where b.status in ('primary', 'secondary') " +
  'order by length(b.batch_id), b.batch_id';

function posNum(v) {
  var n = Number(v);
  return (v !== null && v !== undefined && v !== '' && isFinite(n) && n > 0) ? n : null;
}

function snapshotMax(text) {
  var parsed;
  var steps;
  var max = null;
  var i;
  var n;
  if (typeof text !== 'string' || text === '') return null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return null;
  }
  steps = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.steps) ? parsed.steps : null);
  if (!steps) return null;
  for (i = 0; i < steps.length; i++) {
    n = Number(steps[i] && steps[i].day_offset);
    if (isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

function dayNumber(ymd) {
  var p = String(ymd).split('-');
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}

function vancouverToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

function summarise(rows, today) {
  var t = dayNumber(today || vancouverToday());
  var out = {
    active: 0,
    noSchedule: 0,
    mismatches: [],
    byPlannedDays: { any: 0, plus7: 0, plus14: 0 },
    bySnapshot: { any: 0, plus7: 0, plus14: 0 },
    flat90: 0
  };

  function bucket(target, elapsed, plan) {
    var over;
    if (plan === null) return;
    over = elapsed - plan;
    if (over > 0) target.any++;
    if (over > 7) target.plus7++;
    if (over > 14) target.plus14++;
  }

  (rows || []).forEach(function (r) {
    var elapsed;
    var planned;
    var snap;
    if (r.status !== 'primary' && r.status !== 'secondary') return;
    out.active++;
    elapsed = t - dayNumber(r.start_date);
    planned = posNum(r.planned_days);
    snap = posNum(snapshotMax(r.schedule_snapshot));
    if (planned === null && snap === null) {
      out.noSchedule++;
      return;
    }
    if (planned !== snap) {
      out.mismatches.push({ batch_id: r.batch_id, planned_days: planned, snapshot_max: snap });
    }
    bucket(out.byPlannedDays, elapsed, planned);
    bucket(out.bySnapshot, elapsed, snap);
    if (elapsed > 90) out.flat90++;
  });
  return out;
}

function main() {
  var db = require(path.join(process.cwd(), 'lib', 'db'));
  var pool = db.createPool(process.env.DATABASE_URL);
  pool.query(SQL).then(function (res) {
    console.log('===SPIKE-BEGIN===');
    console.log(JSON.stringify(summarise(res.rows, vancouverToday()), null, 2));
    console.log('===SPIKE-END===');
    return pool.end();
  }).catch(function (err) {
    console.error('spike failed: ' + (err && err.message));
    return pool.end().then(function () { process.exitCode = 1; }, function () { process.exitCode = 1; });
  });
}

module.exports = { snapshotMax: snapshotMax, summarise: summarise };

if (process.argv.indexOf('--run') !== -1) main();

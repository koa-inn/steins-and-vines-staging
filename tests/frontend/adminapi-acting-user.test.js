'use strict';

// Phase 86-03 Task 1: acting_user attribution on the server_token path of doPost.
//
// Harness: loads the REAL apps-script/adminApi.gs via `new Function`, shadowing the Apps Script
// globals (PropertiesService, ContentService, CacheService) with minimal fakes, and re-assigning
// the called action functions (updateBatch, createBatch, ...) after the source so they capture the
// userEmail argument they were handed. This proves the doPost dispatch wiring only; it is a model
// of Apps Script, not proof Google's runtime agrees (the staging rehearsal 86-18 is the real gate).

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');
var SRC = fs.readFileSync(ADMIN_API_PATH, 'utf8');

var STUBBED = [
  'createBatch', 'updateBatch', 'deleteBatch', 'updateBatchTask', 'addBatchTask',
  'bulkUpdateBatchTasks', 'createFermSchedule', 'updateFermSchedule', 'propagateFermSchedule',
  'updateBatchSchedule', 'bulkAddPlatoReadings', 'updatePlatoReading', 'createRecipe',
  'updateRecipe', 'deleteRecipe', 'updateReservation', 'updateHold'
];

function makeDoPost() {
  var calls = [];
  var stubCode = STUBBED.map(function (name) {
    return name + ' = function (payload, userEmail) { __calls.push({ fn: "' + name +
      '", userEmail: userEmail }); return { ok: true, batch_id: "SV-B-000001", recipe_id: "R-1" }; };';
  }).join('\n');
  var factory = new Function(
    '__calls', 'PropertiesService', 'ContentService', 'CacheService',
    SRC + '\n' + stubCode +
      '\ncheckAuthorization = function () { return { authorized: true, email: "oauth@example.com" }; };' +
      '\nreturn doPost;'
  );
  var doPost = factory(
    calls,
    { getScriptProperties: function () { return { getProperty: function () { return 'SECRET'; } }; } },
    {
      MimeType: { JSON: 'json' },
      createTextOutput: function (s) { return { _s: s, setMimeType: function () { return this; } }; }
    },
    { getScriptCache: function () { return { removeAll: function () {}, remove: function () {} }; } }
  );
  return {
    calls: calls,
    post: function (payload, withToken) {
      var p = Object.assign({}, payload);
      if (withToken !== false) p.server_token = 'SECRET';
      return doPost({ postData: { contents: JSON.stringify(p) } });
    }
  };
}

function actorFor(fn, action, extra, withToken) {
  var h = makeDoPost();
  h.post(Object.assign({ action: action, batch_id: 'SV-B-000001' }, extra || {}), withToken);
  var hit = h.calls.filter(function (c) { return c.fn === fn; })[0];
  return hit && hit.userEmail;
}

describe('doPost server_token acting_user attribution', function () {
  test('update_batch passes a valid acting_user through', function () {
    expect(actorFor('updateBatch', 'update_batch', { acting_user: 'staff@example.com' })).toBe('staff@example.com');
  });

  test('update_batch falls back to middleware without acting_user', function () {
    expect(actorFor('updateBatch', 'update_batch')).toBe('middleware');
  });

  test('acting_user is trimmed', function () {
    expect(actorFor('updateBatch', 'update_batch', { acting_user: '  Staff@Example.com  ' })).toBe('Staff@Example.com');
  });

  test.each([
    ['not-an-email', 'not-an-email'],
    ['300-char string', 'a'.repeat(300) + '@example.com'],
    ['number', 5],
    ['object', { email: 'a@b.co' }],
    ['spaced', 'a b@example.com']
  ])('malformed acting_user (%s) falls back to middleware', function (_label, value) {
    expect(actorFor('updateBatch', 'update_batch', { acting_user: value })).toBe('middleware');
  });

  test('create_batch falls back to kiosk-middleware, honours acting_user', function () {
    expect(actorFor('createBatch', 'create_batch')).toBe('kiosk-middleware');
    expect(actorFor('createBatch', 'create_batch', { acting_user: 'staff@example.com' })).toBe('staff@example.com');
  });

  test.each([
    ['createFermSchedule', 'create_ferm_schedule'],
    ['updateFermSchedule', 'update_ferm_schedule'],
    ['propagateFermSchedule', 'propagate_ferm_schedule'],
    ['updateBatchTask', 'update_batch_task'],
    ['addBatchTask', 'add_batch_task'],
    ['bulkUpdateBatchTasks', 'bulk_update_batch_tasks'],
    ['deleteBatch', 'delete_batch'],
    ['updateBatchSchedule', 'update_batch_schedule'],
    ['bulkAddPlatoReadings', 'bulk_add_plato_readings'],
    ['updatePlatoReading', 'update_plato_reading'],
    ['createRecipe', 'create_recipe'],
    ['updateRecipe', 'update_recipe'],
    ['deleteRecipe', 'delete_recipe'],
    ['updateReservation', 'update_reservation'],
    ['updateHold', 'update_hold']
  ])('%s passes the actor through', function (fn, action) {
    expect(actorFor(fn, action, { acting_user: 'staff@example.com' })).toBe('staff@example.com');
    expect(actorFor(fn, action)).toBe('middleware');
  });

  test('staff-OAuth path ignores payload.acting_user', function () {
    expect(actorFor('updateBatch', 'update_batch', { acting_user: 'evil@example.com' }, false)).toBe('oauth@example.com');
  });
});

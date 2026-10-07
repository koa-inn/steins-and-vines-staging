'use strict';

/**
 * Recipes replay-to-sheet - Phase 85 Plan 11 (DB-04, D-02 repair / dual->sheets rollback).
 *
 * Pushes the CURRENT Postgres state of every recipe (recipe + ordered ingredients, exactly as
 * recipe-pg.getRecipe returns them) onto the live sheet via the Apps Script
 * mirror_recipe_state action - the same payload lib/recipe-mirror.js sends, so a replay and a
 * live mirror produce the same sheet state. The action is idempotent per recipe, so a re-run
 * after a partial failure is safe.
 *
 * Dry run by default; --apply is required to send anything. Reads Postgres in one read-only
 * transaction; never writes to Postgres. Stops at the first {ok:false}. Output is recipe ids
 * and counts only. Env only: BACKFILL_DATABASE_URL, APPS_SCRIPT_URL, APPS_SCRIPT_SERVER_TOKEN.
 *
 *   node scripts/backfill/recipes-replay-to-sheet.js            # dry run
 *   node scripts/backfill/recipes-replay-to-sheet.js --apply
 */

var backfillCli = require('./backfill');
var recipePg = require('../../lib/recipe-pg');

var EXIT = backfillCli.EXIT;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var APPS_SCRIPT_TIMEOUT_MS = 30000;

/**
 * buildReplayPayloads(states) -> [{recipe_id, payload: {recipe, ingredients}}] in id order.
 */
function buildReplayPayloads(states) {
  return (states || [])
    .map(function (s) {
      return {
        recipe_id: s.recipe.recipe_id,
        payload: { recipe: s.recipe, ingredients: s.ingredients }
      };
    })
    .sort(function (a, b) {
      return a.recipe_id < b.recipe_id ? -1 : a.recipe_id > b.recipe_id ? 1 : 0;
    });
}

var VALID_FLAGS = ['--apply'];

function parseArgs(argv) {
  var opts = { apply: false };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    if (VALID_FLAGS.indexOf(arg) === -1) {
      throw new Error('unknown flag "' + arg + '" - valid flags: ' + VALID_FLAGS.join(', '));
    }
    opts.apply = true;
  });
  return opts;
}

async function fetchPgStates(pool) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var ids = await recipePg.listRecipeIds(client);
    var states = [];
    for (var i = 0; i < ids.length; i++) {
      var state = await recipePg.getRecipe(client, ids[i]);
      if (state) states.push(state);
    }
    await client.query('commit');
    return states;
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

async function postSequentially(payloads, url, token, axios) {
  var sent = 0;
  for (var i = 0; i < payloads.length; i++) {
    var item = payloads[i];
    var body = JSON.stringify(Object.assign({}, item.payload, {
      action: 'mirror_recipe_state',
      server_token: token
    }));
    var error = null;
    try {
      var res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: APPS_SCRIPT_TIMEOUT_MS,
        maxRedirects: 5
      });
      var data = res && res.data;
      if (!data || data.ok !== true) error = (data && (data.error || data.message)) || 'unknown_error';
    } catch (err) {
      error = err.message;
    }
    if (error) return { sent: sent, failure: { recipe_id: item.recipe_id, error: error } };
    sent++;
  }
  return { sent: sent, failure: null };
}

/**
 * runReplay(opts, deps) -> Promise<{exitCode, sent, total}>. deps: {pool, axios, log}.
 */
async function runReplay(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  try {
    var states = await fetchPgStates(deps.pool);
    var payloads = buildReplayPayloads(states);
    log('Built ' + payloads.length + ' recipe replay payload(s)');

    if (!opts.apply) {
      log('Dry run - no HTTP calls made. Pass --apply to send.');
      return { exitCode: EXIT.OK, sent: 0, total: payloads.length };
    }

    var url = process.env.APPS_SCRIPT_URL;
    var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) {
      log('Error: APPS_SCRIPT_URL and APPS_SCRIPT_SERVER_TOKEN must be set to --apply');
      return { exitCode: EXIT.ERROR, sent: 0, total: payloads.length };
    }

    var result = await postSequentially(payloads, url, token, deps.axios);
    if (result.failure) {
      log('Replay stopped - recipe=' + result.failure.recipe_id + ' error=' + result.failure.error);
      return { exitCode: EXIT.CHECKS_FAILED, sent: result.sent, total: payloads.length };
    }
    log('Replayed ' + result.sent + '/' + payloads.length + ' recipe(s)');
    return { exitCode: EXIT.OK, sent: result.sent, total: payloads.length };
  } catch (err) {
    log('Error: ' + err.message);
    return { exitCode: EXIT.ERROR, sent: 0, total: 0 };
  }
}

function main() {
  var db = require('../../lib/db');
  var opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(EXIT.ERROR);
    return;
  }
  if (!process.env.BACKFILL_DATABASE_URL) {
    console.error('Error: BACKFILL_DATABASE_URL must be set');
    process.exit(EXIT.ERROR);
    return;
  }

  var pool = db.createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 });
  var axios = require('axios');
  runReplay(opts, { pool: pool, axios: axios, log: console.log })
    .then(function (result) {
      return pool.end().then(function () { return result; });
    })
    .then(function (result) { process.exit(result.exitCode); })
    .catch(function (err) {
      console.error('Fatal: ' + err.message);
      pool.end().catch(function () {}).then(function () { process.exit(EXIT.ERROR); });
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReplayPayloads: buildReplayPayloads,
  runReplay: runReplay,
  parseArgs: parseArgs,
  EXIT: EXIT
};

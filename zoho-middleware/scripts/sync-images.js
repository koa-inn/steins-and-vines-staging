/**
 * Sync product images from Zoho Inventory via the middleware.
 *
 * Downloads the image for every kit (product) and ingredient that has a SKU
 * and an item_id. Images are saved as {sku}.png in the output directory.
 *
 * Usage:
 *   node scripts/sync-images.js [options]
 *
 * Options:
 *   --middleware-url <url>   Middleware base URL (default: env MIDDLEWARE_URL or http://localhost:3001)
 *   --output-dir <path>     Where to save images (default: ../../images/products relative to this script)
 *   --dry-run               Log what would be downloaded without writing files
 *
 * Requires the middleware server to be running and authenticated with Zoho.
 */

var fs = require('fs');
var path = require('path');
var axios = require('axios');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

var args = process.argv.slice(2);

function getArg(name, fallback) {
  var idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return fallback;
}

var DRY_RUN = args.indexOf('--dry-run') !== -1;
var MIDDLEWARE_URL = getArg('--middleware-url',
  process.env.MIDDLEWARE_URL || 'http://localhost:3001');
var OUTPUT_DIR = getArg('--output-dir',
  path.join(__dirname, '..', '..', 'images', 'products'));

// Zoho API rate limit: 100 requests per minute — add delay between calls
var DELAY_MS = 700;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function log(msg) {
  console.log('[sync-images] ' + msg);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Middleware URL: ' + MIDDLEWARE_URL);
  log('Output dir:    ' + OUTPUT_DIR);
  if (DRY_RUN) {
    log('=== DRY RUN — no files will be written ===');
  }
  console.log('');

  // Ensure output directory exists
  if (!DRY_RUN && !fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    log('Created output directory: ' + OUTPUT_DIR);
  }

  // Verify middleware is running and authenticated
  try {
    var health = await axios.get(MIDDLEWARE_URL + '/auth/status');
    if (!health.data.authenticated) {
      console.error('[sync-images] Middleware is not authenticated. Visit ' +
        MIDDLEWARE_URL + '/auth/zoho first.');
      process.exit(1);
    }
    log('Middleware is running and authenticated.');
  } catch (e) {
    console.error('[sync-images] Cannot reach middleware at ' + MIDDLEWARE_URL +
      '. Is the server running?');
    process.exit(1);
  }

  // Fetch all products (kits) and ingredients
  log('Fetching products...');
  var productsResp = await axios.get(MIDDLEWARE_URL + '/api/products');
  var products = (productsResp.data && productsResp.data.items) || [];
  log('Found ' + products.length + ' products');

  log('Fetching ingredients...');
  var ingredientsResp = await axios.get(MIDDLEWARE_URL + '/api/ingredients');
  var ingredients = (ingredientsResp.data && ingredientsResp.data.items) || [];
  log('Found ' + ingredients.length + ' ingredients');

  // Combine and deduplicate by item_id
  var seen = {};
  var allItems = [];
  var combined = products.concat(ingredients);
  for (var i = 0; i < combined.length; i++) {
    var item = combined[i];
    if (!item.item_id || !item.sku) continue;
    if (seen[item.item_id]) continue;
    seen[item.item_id] = true;
    allItems.push({ item_id: item.item_id, sku: item.sku, name: item.name || '' });
  }

  log('Total unique items with SKU: ' + allItems.length);
  console.log('');

  // Download images one at a time with rate limiting
  var downloaded = 0;
  var skipped = 0;
  var failed = 0;

  for (var j = 0; j < allItems.length; j++) {
    var entry = allItems[j];
    var filename = entry.sku + '.png';
    var outputPath = path.join(OUTPUT_DIR, filename);

    if (DRY_RUN) {
      log('Would download ' + filename + ' (item_id=' + entry.item_id + ')');
      downloaded++;
      if (j < allItems.length - 1) await sleep(10); // minimal delay in dry run
      continue;
    }

    try {
      var response = await axios.get(
        MIDDLEWARE_URL + '/api/items/' + entry.item_id + '/image',
        { responseType: 'arraybuffer', validateStatus: function (s) { return s < 500; } }
      );

      if (response.status === 404) {
        log('No image for ' + entry.sku);
        skipped++;
      } else if (response.status >= 200 && response.status < 300) {
        // Check if we actually got image data (not a JSON error)
        var contentType = response.headers['content-type'] || '';
        if (contentType.indexOf('application/json') !== -1) {
          log('No image for ' + entry.sku);
          skipped++;
        } else {
          fs.writeFileSync(outputPath, Buffer.from(response.data));
          log('Downloaded ' + filename + ' (' + response.data.length + ' bytes)');
          downloaded++;
        }
      } else {
        log('Unexpected status ' + response.status + ' for ' + entry.sku);
        failed++;
      }
    } catch (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      console.error('[sync-images] Failed for ' + entry.sku + ': ' + msg);
      failed++;
    }

    // Rate limit delay
    if (j < allItems.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log('');
  log('--- Sync Summary ---');
  log('  Total items:  ' + allItems.length);
  log('  Downloaded:   ' + downloaded);
  log('  Skipped:      ' + skipped + ' (no image)');
  log('  Failed:       ' + failed);
}

main().catch(function (err) {
  console.error('[sync-images] Fatal error:', err.message);
  process.exit(1);
});

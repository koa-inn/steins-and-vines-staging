/**
 * Import vessels from CSV into Zoho Books/Inventory as inventory items.
 *
 * Each vessel becomes its own item with:
 *   - SKU  = vessel ID (e.g. PCB-001)
 *   - Name = "Type Material CapacityL" (e.g. "Carboy PET 23L")
 *   - Description = dimensions, location, brand, notes
 *   - item_type = inventory, product_type = goods
 *   - rate = 0 (internal asset, not sold)
 *
 * Usage:
 *   node scripts/import-vessels.js [--dry-run]
 *
 * Requires the server's .env to be configured with valid Zoho credentials
 * and an active refresh token.
 */

var fs = require('fs');
var path = require('path');
var axios = require('axios');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var CSV_PATH = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(__dirname, '..', '..', '..', '..', '..', '..', 'Downloads',
      'STEINS AND VINES - Vessels.csv');

// Resolve the actual CSV path — fall back to an absolute path
var VESSEL_CSV = fs.existsSync(CSV_PATH)
  ? CSV_PATH
  : '/Users/koa/Downloads/STEINS AND VINES - Vessels.csv';

var DRY_RUN = process.argv.includes('--dry-run');

// Route through the running middleware server (handles auth + Zoho domain)
var MIDDLEWARE_URL = 'http://localhost:3001';

// Zoho API rate limit: 100 requests per minute — add a delay between calls
var DELAY_MS = 700;

// ---------------------------------------------------------------------------
// CSV parser (simple, handles quoted fields with commas)
// ---------------------------------------------------------------------------

function parseCSV(text) {
  var lines = text.trim().split('\n');
  var headers = parseLine(lines[0]);
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var vals = parseLine(lines[i]);
    if (vals.length === 0) continue;
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (vals[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseLine(line) {
  var fields = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Build item name from vessel attributes
// ---------------------------------------------------------------------------

function buildItemName(vessel) {
  var parts = [vessel.Type || 'Vessel'];
  if (vessel.Material) parts.push(vessel.Material);
  var cap = vessel['Capacity (L)'];
  if (cap) parts.push(cap + 'L');
  return parts.join(' ') + ' — ' + vessel.ID;
}

function buildDescription(vessel) {
  var lines = [];
  var bottomD = vessel['Bottom Diameter (cm)'];
  var topD = vessel['Top Diameter (cm)'];
  var depth = vessel['Depth (cm)'];
  if (bottomD || topD || depth) {
    var dims = [];
    if (bottomD) dims.push('Bottom ⌀ ' + bottomD + 'cm');
    if (topD) dims.push('Top ⌀ ' + topD + 'cm');
    if (depth) dims.push('Depth ' + depth + 'cm');
    lines.push('Dimensions: ' + dims.join(', '));
  }
  if (vessel.Location) lines.push('Location: ' + vessel.Location);
  if (vessel.Brand) lines.push('Brand: ' + vessel.Brand);
  if (vessel.Notes) lines.push('Notes: ' + vessel.Notes);
  if (vessel.Status) lines.push('Status: ' + vessel.Status);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Zoho API helper
// ---------------------------------------------------------------------------

function createItemViaMiddleware(itemPayload) {
  return axios.post(MIDDLEWARE_URL + '/api/items', itemPayload).then(function (res) {
    return res.data;
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Read and parse CSV
  if (!fs.existsSync(VESSEL_CSV)) {
    console.error('CSV not found: ' + VESSEL_CSV);
    process.exit(1);
  }

  var csv = fs.readFileSync(VESSEL_CSV, 'utf8');
  var vessels = parseCSV(csv);
  console.log('Parsed ' + vessels.length + ' vessels from CSV\n');

  if (DRY_RUN) {
    console.log('=== DRY RUN — no API calls will be made ===\n');
  }

  // Verify middleware is running and authenticated
  if (!DRY_RUN) {
    try {
      var health = await axios.get(MIDDLEWARE_URL + '/health');
      if (!health.data.authenticated) {
        console.error('Middleware is not authenticated. Visit ' + MIDDLEWARE_URL + '/auth/zoho first.');
        process.exit(1);
      }
      console.log('Middleware is running and authenticated.\n');
    } catch (e) {
      console.error('Cannot reach middleware at ' + MIDDLEWARE_URL + '. Is the server running?');
      process.exit(1);
    }
  }

  var created = 0;
  var skipped = 0;
  var errors = [];

  for (var i = 0; i < vessels.length; i++) {
    var vessel = vessels[i];
    if (!vessel.ID) {
      skipped++;
      continue;
    }

    var payload = {
      name: buildItemName(vessel),
      sku: vessel.ID,
      unit: 'pcs',
      item_type: 'inventory',
      product_type: 'goods',
      rate: 0,
      purchase_rate: 0,
      description: buildDescription(vessel),
      // Not sold to customers — internal asset
      // But Zoho requires at least sales or purchases
    };

    var label = '[' + (i + 1) + '/' + vessels.length + '] ' + vessel.ID + ' → ' + payload.name;

    if (DRY_RUN) {
      console.log('  WOULD CREATE: ' + label);
      created++;
      continue;
    }

    try {
      await createItemViaMiddleware(payload);
      console.log('  ✓ Created: ' + label);
      created++;
    } catch (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      console.error('  ✗ Failed:  ' + label + ' — ' + msg);
      errors.push({ id: vessel.ID, error: msg });
    }

    // Rate limit delay
    await sleep(DELAY_MS);
  }

  // Summary
  console.log('\n--- Import Summary ---');
  console.log('  Total vessels: ' + vessels.length);
  console.log('  Created:       ' + created);
  console.log('  Skipped:       ' + skipped);
  console.log('  Errors:        ' + errors.length);

  if (errors.length > 0) {
    console.log('\nFailed items:');
    errors.forEach(function (e) {
      console.log('  ' + e.id + ': ' + e.error);
    });
  }
}

main().catch(function (err) {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

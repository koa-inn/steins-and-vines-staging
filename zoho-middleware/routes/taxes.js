var express = require('express');
var axios = require('axios');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');

var zohoGet = zohoApi.zohoGet;
var zohoPost = zohoApi.zohoPost;
var zohoPut = zohoApi.zohoPut;
var inventoryGet = zohoApi.inventoryGet;
var inventoryPut = zohoApi.inventoryPut;
var fetchAllItems = zohoApi.fetchAllItems;

var PRODUCTS_CACHE_KEY = 'zoho:products';

var router = express.Router();

/**
 * Test if a keyword (possibly with \b word boundary markers) matches in text.
 */
function keywordMatch(kw, text) {
  if (kw.indexOf('\\b') !== -1) {
    return new RegExp(kw, 'i').test(text);
  }
  return text.indexOf(kw.toLowerCase()) !== -1;
}

/**
 * Classify a single Zoho Inventory item into a tax category.
 * Returns an assignment object with category, rule_id, tax_id etc.
 * @param {object} item - Zoho item with name, category_name, description, group_name, item_id
 * @param {object} categories - CATEGORIES map (capital_equipment, ingredients, services, etc.)
 */
function classifyItem(item, categories) {
  var itemName = (item.name || '').toLowerCase();
  var searchText = [
    item.name || '',
    item.category_name || '',
    item.description || '',
    item.group_name || ''
  ].join(' ').toLowerCase();

  // Check capital equipment first (name-only match)
  var capEquip = categories.capital_equipment;
  if (capEquip && capEquip.name_patterns) {
    var isCapEquip = capEquip.name_patterns.some(function (p) {
      return itemName.indexOf(p) !== -1;
    });
    if (isCapEquip) {
      return {
        item_id: item.item_id,
        item_name: item.name,
        category: 'capital_equipment',
        rule_label: capEquip.rule_label,
        rule_id: capEquip.rule_id,
        tax_id: capEquip.tax_id,
        current_purchase_rule: item.purchase_tax_rule_id || '(none)',
        current_tax_id: item.tax_id || '(none)'
      };
    }
  }

  // Check remaining categories in priority order
  var categoryOrder = ['ingredients', 'services', 'liquor', 'packaging', 'hardware'];
  for (var c = 0; c < categoryOrder.length; c++) {
    var catKey = categoryOrder[c];
    var cat = categories[catKey];
    if (!cat || !cat.keywords) continue;
    var hasMatch = cat.keywords.some(function (kw) {
      return keywordMatch(kw, searchText);
    });
    if (hasMatch) {
      return {
        item_id: item.item_id,
        item_name: item.name,
        category: catKey,
        rule_label: cat.rule_label,
        rule_id: cat.rule_id,
        tax_id: cat.tax_id,
        current_purchase_rule: item.purchase_tax_rule_id || '(none)',
        current_tax_id: item.tax_id || '(none)'
      };
    }
  }

  // Default: zero-rated ingredients
  var ingredientsCat = categories.ingredients;
  return {
    item_id: item.item_id,
    item_name: item.name,
    category: 'ingredients (default)',
    rule_label: ingredientsCat.rule_label,
    rule_id: ingredientsCat.rule_id,
    tax_id: ingredientsCat.tax_id,
    current_purchase_rule: item.purchase_tax_rule_id || '(none)',
    current_tax_id: item.tax_id || '(none)'
  };
}

// ---------------------------------------------------------------------------
// CSV Helper & Item Migration
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line, handling quoted fields and escaped double-quotes.
 */
function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// CSV column name -> { label, data_type } for Zoho custom fields.
// Zoho Inventory accepts updates by label (no api_name discovery needed).
// data_type is used to format values before sending.
var CUSTOM_FIELD_MAP = {
  type:              { label: 'Type',           data_type: 'dropdown' },
  subcategory:       { label: 'Subcategory',    data_type: 'text' },
  time:              { label: 'Time',           data_type: 'text' },
  tasting_notes:     { label: 'Tasting Notes',  data_type: 'text' },
  favorite:          { label: 'Favorite',       data_type: 'check_box' },
  body:              { label: 'Body',           data_type: 'text' },
  oak:               { label: 'Oak',            data_type: 'text' },
  sweetness:         { label: 'Sweetness',      data_type: 'text' },
  abv:               { label: 'ABV',            data_type: 'decimal' },
  batch_size_liters: { label: 'Batch Size (L)', data_type: 'decimal' }
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/taxes
 * List all taxes configured in Zoho Books.
 */
router.get('/api/taxes', function (req, res) {
  zohoGet('/settings/taxes')
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      log.error('[api/taxes] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch taxes' });
    });
});

/**
 * GET /api/taxes/rules
 * List tax rules and tax exemptions from Zoho Books settings.
 */
router.get('/api/taxes/rules', function (req, res) {
  Promise.all([
    zohoGet('/settings/taxrules').catch(function (e) { return { error: e.response ? e.response.data : e.message }; }),
    zohoGet('/settings/taxexemptions').catch(function (e) { return { error: e.response ? e.response.data : e.message }; }),
    zohoGet('/settings/taxauthorities').catch(function (e) { return { error: e.response ? e.response.data : e.message }; })
  ])
    .then(function (results) {
      res.json({
        tax_rules: results[0],
        tax_exemptions: results[1],
        tax_authorities: results[2]
      });
    })
    .catch(function (err) {
      log.error('[api/taxes/rules] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch tax rules' });
    });
});

/**
 * POST /api/taxes/rules
 * Try creating a tax rule via the API.
 */
router.post('/api/taxes/rules', function (req, res) {
  zohoPost('/settings/taxrules', req.body)
    .then(function (data) { res.status(201).json(data); })
    .catch(function (err) {
      log.error('[api/taxes/rules POST] ' + err.message);
      res.status(502).json({ error: 'Unable to create tax rule' });
    });
});

/**
 * POST /api/taxes/setup
 * One-time setup: create BC PST Liquor (10%) and a GST + BC PST Liquor
 * tax group. Skips anything that already exists.
 *
 * Your org already has:
 *   GST 5%, BC PST 7%, BC PST + GST 12% (compound), Zero Rate 0%
 *
 * After this runs you'll have all 4 retail tax profiles:
 *   - Zero Rate (0%)                     -> Ingredients
 *   - GST (5%)                           -> Facility Services
 *   - BC PST + GST (12% compound)        -> Packaging, Hardware
 *   - GST + BC PST Liquor (5% + 10%)     -> Finished Commercial Liquor
 */
router.post('/api/taxes/setup', function (req, res) {
  var results = { created: [], skipped: [], errors: [] };

  zohoGet('/settings/taxes')
    .then(function (data) {
      var existing = data.taxes || [];
      var existingByName = {};
      existing.forEach(function (t) { existingByName[t.tax_name] = t; });

      var chain = Promise.resolve();

      // Step 1: Create BC PST Liquor (10%) if missing
      chain = chain.then(function () {
        if (existingByName['BC PST Liquor']) {
          results.skipped.push('BC PST Liquor (already exists: ' + existingByName['BC PST Liquor'].tax_id + ')');
          return;
        }
        // Use same authority as existing BC PST
        var bcAuthority = existingByName['BC PST'] && existingByName['BC PST'].tax_authority_id;
        return zohoPost('/settings/taxes', {
          tax_name: 'BC PST Liquor',
          tax_percentage: 10,
          tax_type: 'tax',
          tax_authority_id: bcAuthority || ''
        }).then(function (resp) {
          var created = resp.tax || {};
          existingByName['BC PST Liquor'] = created;
          results.created.push('BC PST Liquor (10%) -> ' + created.tax_id);
        }).catch(function (err) {
          var msg = err.message;
          if (err.response && err.response.data) msg = err.response.data.message || msg;
          results.errors.push('BC PST Liquor: ' + msg);
        });
      });

      // Step 2: Create GST + BC PST Liquor tax group if missing
      chain = chain.then(function () {
        if (existingByName['GST + BC PST Liquor']) {
          results.skipped.push('GST + BC PST Liquor (already exists: ' + existingByName['GST + BC PST Liquor'].tax_id + ')');
          return;
        }
        var gstId = existingByName['GST'] && existingByName['GST'].tax_id;
        var pstLiquorId = existingByName['BC PST Liquor'] && existingByName['BC PST Liquor'].tax_id;
        if (!gstId || !pstLiquorId) {
          results.errors.push('GST + BC PST Liquor: missing prerequisite taxes (GST=' + gstId + ', PST Liquor=' + pstLiquorId + ')');
          return;
        }
        return zohoPost('/settings/taxes', {
          tax_name: 'GST + BC PST Liquor',
          tax_percentage: 15,
          tax_type: 'compound_tax',
          tax_authority_id: existingByName['GST'].tax_authority_id || '',
          taxes: [
            { tax_id: gstId },
            { tax_id: pstLiquorId }
          ]
        }).then(function (resp) {
          var created = resp.tax || {};
          results.created.push('GST + BC PST Liquor (15%) -> ' + created.tax_id);
        }).catch(function (err) {
          var msg = err.message;
          if (err.response && err.response.data) msg = err.response.data.message || msg;
          results.errors.push('GST + BC PST Liquor: ' + msg);
        });
      });

      return chain;
    })
    .then(function () {
      res.json({ ok: true, results: results });
    })
    .catch(function (err) {
      log.error('[api/taxes/setup] ' + err.message);
      res.status(502).json({ error: 'Unable to set up taxes' });
    });
});

/**
 * POST /api/taxes/apply
 * Assign tax groups to all active items based on category keyword matching.
 *
 * BC FoP retail tax rules:
 *   - Ingredients (juice, malt, yeast, hops, sugar)     -> tax exempt (zero-rated)
 *   - Facility Services (racking, filtering, etc.)       -> GST Only
 *   - Packaging (bottles, corks, labels, capsules)       -> GST + BC PST
 *   - Hardware (airlocks, siphons, hydrometers)          -> GST + BC PST
 *   - Finished Liquor (commercial wine/beer)             -> GST + BC PST Liquor
 *
 * Matches on item name, category, or description fields.
 * Returns a dry-run preview unless body contains { apply: true }.
 */
router.post('/api/taxes/apply', function (req, res) {
  var dryRun = !(req.body && req.body.apply === true);

  // Keyword sets for each tax category (matched case-insensitively)
  // Tax rule/tax IDs are configurable via env vars (defaults = current Zoho org values)
  var TAX_STANDARD_RULE   = process.env.ZOHO_TAX_STANDARD_RULE   || '109900000000033423';
  var TAX_STANDARD_ID     = process.env.ZOHO_TAX_STANDARD_ID     || '109900000000029101';
  var TAX_ZERO_RULE       = process.env.ZOHO_TAX_ZERO_RULE       || '109900000000033411';
  var TAX_ZERO_ID         = process.env.ZOHO_TAX_ZERO_ID         || '109900000000014433';
  var TAX_SERVICES_RULE   = process.env.ZOHO_TAX_SERVICES_RULE   || '109900000000033417';
  var TAX_SERVICES_ID     = process.env.ZOHO_TAX_SERVICES_ID     || '109900000000014425';
  var TAX_LIQUOR_RULE     = process.env.ZOHO_TAX_LIQUOR_RULE     || '109900000000033429';
  var TAX_LIQUOR_ID       = process.env.ZOHO_TAX_LIQUOR_ID       || '109900000000033001';

  var CATEGORIES = {
    // tax_id = direct sales tax shown on item page
    // purchase_tax_id = direct purchase tax shown on item page
    // Capital equipment matched by name pattern (internal use, same tax as packaging/hardware)
    capital_equipment: {
      name_patterns: ['bucket', 'carboy', 'boil kettle', 'fermenter', 'pump', 'filter unit'],
      rule_id: TAX_STANDARD_RULE, // GST + PST - Standard (12%)
      tax_id: TAX_STANDARD_ID,    // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    ingredients: {
      keywords: ['juice', 'malt', 'yeast', 'hops', 'sugar', 'concentrate', 'grape',
                 'bentonite', 'oak', 'additive', 'nutrient', 'stabilizer', 'ingredient',
                 'kit', 'wine kit', 'beer kit', 'cider kit'],
      rule_id: TAX_ZERO_RULE,     // Zero Rated - Ingredients (0%)
      tax_id: TAX_ZERO_ID,        // Zero Rate [0%]
      rule_label: 'Zero Rated - Ingredients (0%)'
    },
    services: {
      keywords: ['\\bservice\\b', '\\bracking\\b', '\\bfiltering\\b', '\\bfiltration\\b',
                 '\\bcarbonation\\b', '\\bguidance\\b', '\\bconsultation\\b',
                 '\\bfee\\b', '\\blabour\\b', '\\blabor\\b'],
      rule_id: TAX_SERVICES_RULE, // GST Only - Services (5%)
      tax_id: TAX_SERVICES_ID,    // GST [5%]
      rule_label: 'GST Only - Services (5%)'
    },
    packaging: {
      keywords: ['bottle', 'cork', 'label', 'capsule', 'shrink', '\\bcap\\b', 'closure',
                 'carton', '\\bcase\\b', '\\bbox\\b', 'packaging'],
      rule_id: TAX_STANDARD_RULE, // GST + PST - Standard (12%)
      tax_id: TAX_STANDARD_ID,    // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    hardware: {
      keywords: ['airlock', 'siphon', 'hydrometer', 'thermometer', 'tubing',
                 'spigot', 'bung', 'stopper', 'brush', 'sanitizer', 'cleaner',
                 'equipment', 'hardware', '\\btool\\b', 'accessory'],
      rule_id: TAX_STANDARD_RULE, // GST + PST - Standard (12%)
      tax_id: TAX_STANDARD_ID,    // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    liquor: {
      keywords: ['commercial wine', 'commercial beer', 'commercial liquor',
                 'finished wine', 'finished beer', 'ready to drink', 'rtd'],
      rule_id: TAX_LIQUOR_RULE,   // GST + PST Liquor (15%)
      tax_id: TAX_LIQUOR_ID,      // GST + BC PST Liquor [15%]
      rule_label: 'GST + PST Liquor (15%)'
    }
  };

  inventoryGet('/items', { status: 'active' })
    .then(function (data) {
      var items = data.items || [];

      var assignments = [];
      items.forEach(function (item) {
        assignments.push(classifyItem(item, CATEGORIES));
      });

      if (dryRun) {
        return res.json({
          mode: 'dry-run',
          note: 'Send { "apply": true } to execute these changes',
          assignments: assignments,
          summary: {
            total_items: items.length,
            assigned: assignments.length
          }
        });
      }

      // Apply in batches of 25 with 2s between items and 60s between batches
      var BATCH_SIZE = 25;
      var ITEM_DELAY = 2000;
      var BATCH_DELAY = 60000;

      var applied = [];
      var skipped = [];
      var errors = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      // Filter to only items that need updating (check both purchase rule and sales tax_id)
      var toUpdate = [];
      assignments.forEach(function (a) {
        var purchaseOk = a.current_purchase_rule === a.rule_id;
        var salesOk = a.current_tax_id === a.tax_id;
        if (purchaseOk && salesOk) {
          skipped.push(a.item_name);
        } else {
          toUpdate.push(a);
        }
      });

      // Process one batch of items
      function processBatch(batch) {
        var chain = Promise.resolve();
        batch.forEach(function (a, idx) {
          chain = chain.then(function () {
            // Delay before each item (skip delay for first item in batch)
            return (idx > 0 ? delay(ITEM_DELAY) : Promise.resolve());
          }).then(function () {
            log.info('[taxes/apply] Updating: ' + a.item_name);
            return inventoryPut('/items/' + a.item_id, {
              purchase_tax_rule_id: a.rule_id,
              tax_id: a.tax_id   // sales tax — what the frontend reads
            });
          }).then(function () {
            applied.push(a.item_name + ' -> ' + a.rule_label);
          }).catch(function (err) {
            var msg = err.message;
            if (err.response && err.response.data) msg = err.response.data.message || msg;
            errors.push(a.item_name + ': ' + msg);
          });
        });
        return chain;
      }

      // Split into batches and process with pauses
      var batches = [];
      for (var b = 0; b < toUpdate.length; b += BATCH_SIZE) {
        batches.push(toUpdate.slice(b, b + BATCH_SIZE));
      }

      var batchChain = Promise.resolve();
      batches.forEach(function (batch, batchIdx) {
        batchChain = batchChain.then(function () {
          log.info('[taxes/apply] Batch ' + (batchIdx + 1) + '/' + batches.length + ' (' + batch.length + ' items)');
          return processBatch(batch);
        }).then(function () {
          // Pause between batches (skip after last batch)
          if (batchIdx < batches.length - 1) {
            log.info('[taxes/apply] Waiting 60s before next batch...');
            return delay(BATCH_DELAY);
          }
        });
      });

      return batchChain.then(function () {
        cache.del(PRODUCTS_CACHE_KEY);

        res.json({
          mode: 'applied',
          applied: applied,
          skipped: skipped.length,
          errors: errors,
          summary: {
            updated: applied.length,
            skipped: skipped.length,
            errors: errors.length
          }
        });
      });
    })
    .catch(function (err) {
      log.error('[api/taxes/apply] ' + err.message);
      res.status(502).json({ error: 'Unable to apply taxes' });
    });
});

/**
 * POST /api/taxes/test-update
 * Debug route: try updating a single item's tax and return the full Zoho response.
 * Body: { item_id, tax_id }
 */
router.post('/api/taxes/test-update', function (req, res) {
  var itemId = req.body && req.body.item_id;
  var taxId = req.body && req.body.tax_id;
  var mode = (req.body && req.body.mode) || 'json';
  if (!itemId || !taxId) return res.status(400).json({ error: 'Need item_id and tax_id' });

  var doUpdate;

  if (mode === 'inventory') {
    // Update via Zoho Inventory API
    doUpdate = inventoryPut('/items/' + itemId, { sales_tax_rule_id: taxId });
  } else if (mode === 'sales_rule') {
    // Update via Zoho Books API with sales_tax_rule_id
    doUpdate = zohoPut('/items/' + itemId, { sales_tax_rule_id: taxId });
  } else {
    doUpdate = zohoPut('/items/' + itemId, { tax_id: taxId });
  }

  doUpdate
    .then(function (data) {
      // Extract just the tax fields from response
      var item = data.item || {};
      res.json({
        ok: true,
        mode: mode,
        result: {
          tax_id: item.tax_id,
          tax_name: item.tax_name,
          tax_percentage: item.tax_percentage,
          is_taxable: item.is_taxable,
          tax_exemption_id: item.tax_exemption_id,
          sales_tax_rule_id: item.sales_tax_rule_id
        }
      });
    })
    .catch(function (err) {
      log.error('[api/taxes/test-update] ' + err.message);
      res.status(502).json({ error: 'Unable to update item tax' });
    });
});

/**
 * GET /api/items/inspect
 * Fetch a single item's full detail to discover available custom fields.
 * Query: ?item_id=...  (optional — defaults to first active item)
 */
router.get('/api/items/inspect', function (req, res) {
  var itemIdPromise;

  if (req.query.item_id) {
    itemIdPromise = Promise.resolve(req.query.item_id);
  } else {
    itemIdPromise = inventoryGet('/items', { status: 'active', per_page: 1 })
      .then(function (data) {
        var items = data.items || [];
        if (items.length === 0) throw new Error('No active items found');
        return items[0].item_id;
      });
  }

  itemIdPromise
    .then(function (itemId) {
      return inventoryGet('/items/' + itemId);
    })
    .then(function (data) {
      var item = data.item || {};

      var customFields = (item.custom_fields || []).map(function (cf) {
        return {
          api_name: cf.api_name || cf.customfield_id,
          label: cf.label,
          data_type: cf.data_type,
          value: cf.value
        };
      });

      res.json({
        item_id: item.item_id,
        name: item.name,
        sku: item.sku,
        rate: item.rate,
        standard_fields: {
          name: item.name,
          sku: item.sku,
          rate: item.rate,
          status: item.status,
          group_name: item.group_name,
          category_name: item.category_name
        },
        custom_fields: customFields,
        custom_field_count: customFields.length
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) msg = err.response.data.message || msg;
      log.error('[api/items/inspect] ' + msg);
      res.status(502).json({ error: 'Unable to inspect item' });
    });
});

/**
 * POST /api/items/test-cf
 * Test updating a custom field on a single item.
 */
router.post('/api/items/test-cf', function (req, res) {
  var itemId = req.body && req.body.item_id;
  var label = req.body && req.body.label;
  var value = req.body && req.body.value;
  if (!itemId || !label) return res.status(400).json({ error: 'Need item_id and label' });

  inventoryPut('/items/' + itemId, {
    custom_fields: [{ label: label, value: value }]
  })
    .then(function (data) {
      var item = data.item || {};
      res.json({
        ok: true,
        custom_fields: item.custom_fields,
        custom_field_hash: item.custom_field_hash
      });
    })
    .catch(function (err) {
      log.error('[api/items/test-cf] ' + err.message);
      res.status(502).json({ error: 'Unable to update custom field' });
    });
});

/**
 * POST /api/items/migrate
 * Read products CSV, match to Zoho Inventory items by SKU, and update
 * standard + custom fields.
 *
 * Body: { csv_url: "..." OR csv_path: "/local/file.csv", apply: false, match_by: "sku" }
 *
 * Dry run (apply: false) returns proposed changes without updating.
 * Apply (apply: true) updates items with rate limiting (25/batch, 2s between
 * items, 60s between batches).
 */
router.post('/api/items/migrate', function (req, res) {
  var body = req.body || {};
  var csvUrl = body.csv_url;
  var applyChanges = body.apply === true;
  var matchBy = body.match_by || 'sku';

  if (!csvUrl) {
    return res.status(400).json({ error: 'Missing csv_url' });
  }

  var csvRows, zohoItems;

  // Step 1: Fetch CSV (csv_path removed to prevent path traversal)
  var csvPromise = axios.get(csvUrl, { responseType: 'text', timeout: 30000 });

  csvPromise
    .then(function (csvResp) {
      var lines = csvResp.data.split('\n');
      var headerLine = lines[0];
      if (!headerLine) throw new Error('CSV is empty');

      var headers = parseCSVLine(headerLine.replace(/\r$/, ''));
      headers = headers.map(function (h) {
        return h.trim().toLowerCase().replace(/\s+/g, '_');
      });

      csvRows = [];
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '').trim();
        if (!line) continue;

        var values = parseCSVLine(line);
        var row = {};
        headers.forEach(function (h, idx) {
          row[h] = (values[idx] || '').trim();
        });
        csvRows.push(row);
      }

      // Step 2: Fetch all active Zoho items
      return fetchAllItems({ status: 'active' });
    })
    .then(function (items) {
      zohoItems = items;
      if (items.length === 0) throw new Error('No active items in Zoho Inventory');

      // Build SKU/name lookups
      var skuMap = {};
      var nameMap = {};
      zohoItems.forEach(function (item) {
        if (item.sku) skuMap[item.sku] = item;
        if (item.name) nameMap[item.name.toLowerCase()] = item;
      });

      // Match CSV rows and build update payloads
      var matched = [];
      var unmatched = [];

      csvRows.forEach(function (row) {
        var zohoItem = null;
        if (matchBy === 'sku' && row.sku) {
          zohoItem = skuMap[row.sku];
        }
        if (!zohoItem && row.name) {
          zohoItem = nameMap[row.name.toLowerCase()];
        }

        if (!zohoItem) {
          unmatched.push((row.name || '(no name)') + ' (' + (row.sku || 'no SKU') + ')');
          return;
        }

        var changes = {};
        var customFieldUpdates = [];

        // Standard field: rate from retail_instore
        if (row.retail_instore) {
          var rate = parseFloat(row.retail_instore.replace(/[$,]/g, ''));
          if (!isNaN(rate) && rate > 0) {
            changes.rate = rate;
          }
        }

        // Standard field: brand
        if (row.brand && row.brand !== '') {
          changes.brand = row.brand;
        }

        // Custom fields — use label-based updates (Zoho accepts { label, value })
        Object.keys(CUSTOM_FIELD_MAP).forEach(function (csvCol) {
          if (row[csvCol] === undefined || row[csvCol] === '') return;

          var fieldDef = CUSTOM_FIELD_MAP[csvCol];
          var value = row[csvCol];

          // Format value based on field data type
          if (fieldDef.data_type === 'decimal' || fieldDef.data_type === 'number') {
            value = parseFloat(value.replace(/[$,%]/g, ''));
            if (isNaN(value)) return;
          } else if (fieldDef.data_type === 'check_box') {
            value = value.toUpperCase() === 'TRUE';
          }

          customFieldUpdates.push({
            label: fieldDef.label,
            value: value
          });
          changes[fieldDef.label] = value;
        });

        if (Object.keys(changes).length > 0 || customFieldUpdates.length > 0) {
          matched.push({
            item_id: zohoItem.item_id,
            name: zohoItem.name,
            sku: zohoItem.sku || row.sku,
            changes: changes,
            custom_fields: customFieldUpdates
          });
        }
      });

      // Dry run — return proposed changes
      if (!applyChanges) {
        return res.json({
          mode: 'dry-run',
          note: 'Send { "apply": true } to execute these changes',
          matched: matched.length,
          unmatched: unmatched.length,
          unmatched_items: unmatched,
          updates: matched,
          zoho_items_total: zohoItems.length,
          csv_rows_total: csvRows.length
        });
      }

      // Apply changes with rate limiting
      var BATCH_SIZE = 25;
      var ITEM_DELAY = 2000;
      var BATCH_DELAY = 60000;

      var applied = [];
      var errors = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      function processBatch(batch) {
        var chain = Promise.resolve();
        batch.forEach(function (update, idx) {
          chain = chain.then(function () {
            return (idx > 0 ? delay(ITEM_DELAY) : Promise.resolve());
          }).then(function () {
            log.info('[items/migrate] Updating: ' + update.name + ' (' + update.sku + ')');

            var payload = {};
            if (update.changes.rate !== undefined) {
              payload.rate = update.changes.rate;
            }
            if (update.changes.brand !== undefined) {
              payload.brand = update.changes.brand;
            }
            if (update.custom_fields.length > 0) {
              payload.custom_fields = update.custom_fields;
            }

            return inventoryPut('/items/' + update.item_id, payload);
          }).then(function () {
            applied.push(update.name);
          }).catch(function (err) {
            var msg = err.message;
            if (err.response && err.response.data) msg = err.response.data.message || msg;
            errors.push(update.name + ': ' + msg);
          });
        });
        return chain;
      }

      var batches = [];
      for (var b = 0; b < matched.length; b += BATCH_SIZE) {
        batches.push(matched.slice(b, b + BATCH_SIZE));
      }

      var batchChain = Promise.resolve();
      batches.forEach(function (batch, batchIdx) {
        batchChain = batchChain.then(function () {
          log.info('[items/migrate] Batch ' + (batchIdx + 1) + '/' + batches.length + ' (' + batch.length + ' items)');
          return processBatch(batch);
        }).then(function () {
          if (batchIdx < batches.length - 1) {
            log.info('[items/migrate] Waiting 60s before next batch...');
            return delay(BATCH_DELAY);
          }
        });
      });

      return batchChain.then(function () {
        cache.del(PRODUCTS_CACHE_KEY);

        res.json({
          mode: 'applied',
          applied: applied.length,
          errors: errors,
          summary: {
            updated: applied.length,
            failed: errors.length,
            unmatched: unmatched.length
          }
        });
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) msg = err.response.data.message || msg;
      log.error('[api/items/migrate] ' + msg);
      res.status(502).json({ error: 'Unable to migrate items' });
    });
});

module.exports = router;
module.exports.parseCSVLine = parseCSVLine;
module.exports.keywordMatch = keywordMatch;
module.exports.classifyItem = classifyItem;

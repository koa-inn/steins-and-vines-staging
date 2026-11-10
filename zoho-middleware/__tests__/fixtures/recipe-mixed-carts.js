'use strict';

// Shared recipe fixtures for Phase 101 (kiosk mixed recipe carts + full tenders).
//
// Plan 101-01 wrote the ORACLE block below from what the CURRENT legacy
// recipe route (routes/pos-recipe.js at 9b782e84) charges and books. Plans
// 03-06 import these fixtures and assert the merged /api/kiosk/sale path
// reproduces the same numbers. Never regenerate ORACLE from new code.
//
// Case keys look like  RCP-LOCKED/in-store/cart-pct  or
// RCP-DYN/in-store/none/scale2x  (recipe / mode / discount[/variant]).

var FEE_IDS = {
  makers: 'fee-makers-1',
  materials: 'fee-materials-1',
  milling: 'fee-milling-1'
};

// Full ingredient catalog (zoho:ingredients:all). Fee items are services and
// are normally absent; the milling item is here because priceRecipe reads the
// milling rate from this map (its tax comes from KIOSK_FEE_CATALOG).
var MOCK_INGREDIENTS_CATALOG = [
  // Grain: priced per kg, sold in kg.
  { item_id: 'ing-grain-1', name: 'Pale Malt 2-Row', rate: 3.5, unit: 'kg', tax_id: 'tax-gst', tax_percentage: 5, stock_on_hand: 50 },
  // Hop: priced per kg, recipe lines are in g (0.1 kg == 100 g) so unit conversion is exercised.
  { item_id: 'ing-hop-1', name: 'Cascade Hops', rate: 80, unit: 'kg', tax_id: 'tax-gst', tax_percentage: 5, stock_on_hand: 2 },
  // Yeast: zero-rate exception (tax_id present, 0%).
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5, unit: 'pcs', tax_id: 'tax-zero', tax_percentage: 0, stock_on_hand: 10 },
  { item_id: FEE_IDS.milling, name: 'Milling Fee', rate: 10, unit: 'pcs', stock_on_hand: 0 }
];

function recipeResponse(recipe, ingredients) {
  return { ok: true, data: { recipe: recipe, ingredients: ingredients } };
}

// Both recipes share the grain item so later plans can test combined stock (D-13).
var MOCK_RECIPES = {
  'RCP-LOCKED': recipeResponse({
    recipe_id: 'RCP-LOCKED',
    name: 'Locked Pale Ale',
    style: 'American Pale Ale',
    abv: 5.2,
    batch_size_l: 23,
    pricing_mode: 'locked',
    locked_price: 195,
    service_fee: 45,
    materials_fee: 5,
    status: 'active'
  }, [
    { ingredient_id: 'ING-L1', recipe_id: 'RCP-LOCKED', item_id: 'ing-grain-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
    { ingredient_id: 'ING-L2', recipe_id: 'RCP-LOCKED', item_id: 'ing-hop-1', item_name: 'Cascade Hops', quantity: 100, unit: 'g' },
    { ingredient_id: 'ING-L3', recipe_id: 'RCP-LOCKED', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
  ]),
  'RCP-DYN': recipeResponse({
    recipe_id: 'RCP-DYN',
    name: 'Dynamic Amber',
    style: 'Amber Ale',
    abv: 5.0,
    batch_size_l: 23,
    pricing_mode: 'dynamic',
    locked_price: 0,
    service_fee: 45,
    materials_fee: 5,
    status: 'active'
  }, [
    { ingredient_id: 'ING-D1', recipe_id: 'RCP-DYN', item_id: 'ing-grain-1', item_name: 'Pale Malt 2-Row', quantity: 6, unit: 'kg' },
    { ingredient_id: 'ING-D2', recipe_id: 'RCP-DYN', item_id: 'ing-hop-1', item_name: 'Cascade Hops', quantity: 50, unit: 'g' },
    { ingredient_id: 'ING-D3', recipe_id: 'RCP-DYN', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 2, unit: 'pcs' }
  ])
};

// Kiosk products catalog: fee tax rates (Makers 5% GST, Materials/Milling 12% PST+GST).
var KIOSK_FEE_CATALOG = [
  { item_id: FEE_IDS.makers, tax_percentage: 5 },
  { item_id: FEE_IDS.materials, tax_percentage: 12 },
  { item_id: FEE_IDS.milling, tax_percentage: 12 }
];

// kiosk:discount-presets cache value.
var DISCOUNT_PRESETS = [
  { id: 'p-cart-pct', name: 'Cart 10%', active: true, scope: 'cart', type: 'percentage', value: 10 },
  { id: 'p-cart-fixed', name: 'Cart $7.50 off', active: true, scope: 'cart', type: 'fixed', value: 7.5 },
  { id: 'p-type-recipe', name: 'Recipe 10%', active: true, scope: 'type', type: 'percentage', value: 10, applies_to: ['recipe'] },
  { id: 'p-type-service', name: 'Service 10%', active: true, scope: 'type', type: 'percentage', value: 10, applies_to: ['service'] }
];

// discount key -> preset id (null = no discount)
var DISCOUNT_KEYS = {
  'none': null,
  'cart-pct': 'p-cart-pct',
  'cart-fixed': 'p-cart-fixed',
  'type-recipe': 'p-type-recipe',
  'type-service': 'p-type-service'
};

// ORACLE-BEGIN
var ORACLE = {
  initiate: {
    'RCP-LOCKED/in-store/none': {
      charge: 249.21,
      total_before_tax: 245,
      tax_total: 4.21
    },
    'RCP-LOCKED/in-store/cart-pct': {
      charge: 223.46,
      total_before_tax: 220.5,
      tax_total: 2.96
    },
    'RCP-LOCKED/in-store/cart-fixed': {
      charge: 241.33,
      total_before_tax: 237.5,
      tax_total: 3.83
    },
    'RCP-LOCKED/in-store/type-recipe': {
      charge: 228.89,
      total_before_tax: 225.5,
      tax_total: 3.39
    },
    'RCP-LOCKED/in-store/type-service': {
      charge: 243.93,
      total_before_tax: 240,
      tax_total: 3.93
    },
    'RCP-LOCKED/take-out/none': {
      charge: 196.36,
      total_before_tax: 195,
      tax_total: 1.36
    },
    'RCP-LOCKED/take-out/cart-pct': {
      charge: 176.04,
      total_before_tax: 175.5,
      tax_total: 0.54
    },
    'RCP-LOCKED/take-out/cart-fixed': {
      charge: 188.55,
      total_before_tax: 187.5,
      tax_total: 1.05
    },
    'RCP-LOCKED/take-out/type-recipe': {
      charge: 176.04,
      total_before_tax: 175.5,
      tax_total: 0.54
    },
    'RCP-LOCKED/take-out/type-service': {
      charge: 196.36,
      total_before_tax: 195,
      tax_total: 1.36
    },
    'RCP-LOCKED/take-out-mill/none': {
      charge: 207.56,
      total_before_tax: 205,
      tax_total: 2.56
    },
    'RCP-LOCKED/take-out-mill/cart-pct': {
      charge: 185.82,
      total_before_tax: 184.5,
      tax_total: 1.32
    },
    'RCP-LOCKED/take-out-mill/cart-fixed': {
      charge: 199.61,
      total_before_tax: 197.5,
      tax_total: 2.11
    },
    'RCP-LOCKED/take-out-mill/type-recipe': {
      charge: 187.24,
      total_before_tax: 185.5,
      tax_total: 1.74
    },
    'RCP-LOCKED/take-out-mill/type-service': {
      charge: 206.44,
      total_before_tax: 204,
      tax_total: 2.44
    },
    'RCP-LOCKED/in-store/none/scale2x': {
      charge: 445.57,
      total_before_tax: 440,
      tax_total: 5.57
    },
    'RCP-LOCKED/take-out-mill/cart-pct/scale2x': {
      charge: 361.82,
      total_before_tax: 360,
      tax_total: 1.82
    },
    'RCP-LOCKED/in-store/none/modified': {
      charge: 249.41,
      total_before_tax: 245,
      tax_total: 4.41
    },
    'RCP-LOCKED/take-out/type-recipe/modified': {
      charge: 176.22,
      total_before_tax: 175.5,
      tax_total: 0.72
    },
    'RCP-DYN/in-store/none': {
      charge: 89.1,
      total_before_tax: 85,
      tax_total: 4.1
    },
    'RCP-DYN/in-store/cart-pct': {
      charge: 80.19,
      total_before_tax: 76.5,
      tax_total: 3.69
    },
    'RCP-DYN/in-store/cart-fixed': {
      charge: 81.24,
      total_before_tax: 77.5,
      tax_total: 3.74
    },
    'RCP-DYN/in-store/type-recipe': {
      charge: 85.48,
      total_before_tax: 81.5,
      tax_total: 3.98
    },
    'RCP-DYN/in-store/type-service': {
      charge: 83.82,
      total_before_tax: 80,
      tax_total: 3.82
    },
    'RCP-DYN/take-out/none': {
      charge: 36.25,
      total_before_tax: 35,
      tax_total: 1.25
    },
    'RCP-DYN/take-out/cart-pct': {
      charge: 32.63,
      total_before_tax: 31.5,
      tax_total: 1.13
    },
    'RCP-DYN/take-out/cart-fixed': {
      charge: 28.48,
      total_before_tax: 27.5,
      tax_total: 0.98
    },
    'RCP-DYN/take-out/type-recipe': {
      charge: 32.63,
      total_before_tax: 31.5,
      tax_total: 1.13
    },
    'RCP-DYN/take-out/type-service': {
      charge: 36.25,
      total_before_tax: 35,
      tax_total: 1.25
    },
    'RCP-DYN/take-out-mill/none': {
      charge: 47.45,
      total_before_tax: 45,
      tax_total: 2.45
    },
    'RCP-DYN/take-out-mill/cart-pct': {
      charge: 42.71,
      total_before_tax: 40.5,
      tax_total: 2.21
    },
    'RCP-DYN/take-out-mill/cart-fixed': {
      charge: 39.54,
      total_before_tax: 37.5,
      tax_total: 2.04
    },
    'RCP-DYN/take-out-mill/type-recipe': {
      charge: 43.83,
      total_before_tax: 41.5,
      tax_total: 2.33
    },
    'RCP-DYN/take-out-mill/type-service': {
      charge: 46.33,
      total_before_tax: 44,
      tax_total: 2.33
    },
    'RCP-DYN/in-store/none/scale2x': {
      charge: 125.35,
      total_before_tax: 120,
      tax_total: 5.35
    },
    'RCP-DYN/take-out-mill/cart-pct/scale2x': {
      charge: 75.33,
      total_before_tax: 72,
      tax_total: 3.33
    },
    'RCP-DYN/in-store/none/modified': {
      charge: 91.62,
      total_before_tax: 87.4,
      tax_total: 4.22
    },
    'RCP-DYN/take-out/type-recipe/modified': {
      charge: 34.89,
      total_before_tax: 33.66,
      tax_total: 1.23
    }
  },
  confirm: {
    'RCP-LOCKED/in-store/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 4.21,
      payment_amount: 249.21
    },
    'RCP-LOCKED/in-store/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 5.73,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 2.38,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 1.49,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 13.4
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 1.5
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 2.96,
      payment_amount: 223.46
    },
    'RCP-LOCKED/in-store/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 1.76,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 0.73,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 0.46,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 4.1
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 0.45
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 3.83,
      payment_amount: 241.33
    },
    'RCP-LOCKED/in-store/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 11.64,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 4.84,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 3.02,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 3.39,
      payment_amount: 228.89
    },
    'RCP-LOCKED/in-store/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 4.5
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 0.5
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 3.93,
      payment_amount: 243.93
    },
    'RCP-LOCKED/take-out/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 1.36,
      payment_amount: 196.36
    },
    'RCP-LOCKED/take-out/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 11.64,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 4.84,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 3.02,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 0.54,
      payment_amount: 176.04
    },
    'RCP-LOCKED/take-out/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 4.48,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 1.86,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 1.16,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 1.05,
      payment_amount: 188.55
    },
    'RCP-LOCKED/take-out/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 11.64,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 4.84,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 3.02,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 0.54,
      payment_amount: 176.04
    },
    'RCP-LOCKED/take-out/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 1.36,
      payment_amount: 196.36
    },
    'RCP-LOCKED/take-out-mill/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 2.56,
      payment_amount: 207.56
    },
    'RCP-LOCKED/take-out-mill/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 9.34,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 3.88,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 2.43,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 4.85
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 1.32,
      payment_amount: 185.82
    },
    'RCP-LOCKED/take-out-mill/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 3.42,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 1.42,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 0.89,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1.77
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 2.11,
      payment_amount: 199.61
    },
    'RCP-LOCKED/take-out-mill/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 11.64,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 4.84,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 3.02,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 1.74,
      payment_amount: 187.24
    },
    'RCP-LOCKED/take-out-mill/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1
        }
      ],
      adjustment: 162.75,
      adjustment_description: 'Recipe package price',
      tax: 2.44,
      payment_amount: 206.44
    },
    'RCP-LOCKED/in-store/none/scale2x': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 11,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.2,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      adjustment: 325.5,
      adjustment_description: 'Recipe package price',
      tax: 5.57,
      payment_amount: 445.57
    },
    'RCP-LOCKED/take-out-mill/cart-pct/scale2x': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 11,
          rate: 3.5,
          discount: 20.67,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.2,
          rate: 80,
          discount: 8.59,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 5.37,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 5.37
        }
      ],
      adjustment: 325.5,
      adjustment_description: 'Recipe package price',
      tax: 1.82,
      payment_amount: 361.82
    },
    'RCP-LOCKED/in-store/none/modified': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.15,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      adjustment: 158.75,
      adjustment_description: 'Recipe package price',
      tax: 4.41,
      payment_amount: 249.41
    },
    'RCP-LOCKED/take-out/type-recipe/modified': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 5.5,
          rate: 3.5,
          discount: 10.36,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.15,
          rate: 80,
          discount: 6.46,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 1,
          rate: 5,
          discount: 2.68,
          tax_id: 'tax-zero'
        }
      ],
      adjustment: 158.75,
      adjustment_description: 'Recipe package price',
      tax: 0.72,
      payment_amount: 176.22
    },
    'RCP-DYN/in-store/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      tax: 4.1,
      payment_amount: 89.1
    },
    'RCP-DYN/in-store/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 4.5
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 0.5
        }
      ],
      tax: 3.69,
      payment_amount: 80.19
    },
    'RCP-DYN/in-store/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 1.85,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.35,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 0.88,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 3.97
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 0.45
        }
      ],
      tax: 3.74,
      payment_amount: 81.24
    },
    'RCP-DYN/in-store/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      tax: 3.98,
      payment_amount: 85.48
    },
    'RCP-DYN/in-store/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45,
          discount: 4.5
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5,
          discount: 0.5
        }
      ],
      tax: 3.82,
      payment_amount: 83.82
    },
    'RCP-DYN/take-out/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        }
      ],
      tax: 1.25,
      payment_amount: 36.25
    },
    'RCP-DYN/take-out/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        }
      ],
      tax: 1.13,
      payment_amount: 32.63
    },
    'RCP-DYN/take-out/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 4.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.86,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 2.14,
          tax_id: 'tax-zero'
        }
      ],
      tax: 0.98,
      payment_amount: 28.48
    },
    'RCP-DYN/take-out/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        }
      ],
      tax: 1.13,
      payment_amount: 32.63
    },
    'RCP-DYN/take-out/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        }
      ],
      tax: 1.25,
      payment_amount: 36.25
    },
    'RCP-DYN/take-out-mill/none': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10
        }
      ],
      tax: 2.45,
      payment_amount: 47.45
    },
    'RCP-DYN/take-out-mill/cart-pct': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1
        }
      ],
      tax: 2.21,
      payment_amount: 42.71
    },
    'RCP-DYN/take-out-mill/cart-fixed': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.67,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1.67,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1.66
        }
      ],
      tax: 2.04,
      payment_amount: 39.54
    },
    'RCP-DYN/take-out-mill/type-recipe': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          discount: 0.4,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10
        }
      ],
      tax: 2.33,
      payment_amount: 43.83
    },
    'RCP-DYN/take-out-mill/type-service': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.05,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1
        }
      ],
      tax: 2.33,
      payment_amount: 46.33
    },
    'RCP-DYN/in-store/none/scale2x': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 12,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 4,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      tax: 5.35,
      payment_amount: 125.35
    },
    'RCP-DYN/take-out-mill/cart-pct/scale2x': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 12,
          rate: 3.5,
          discount: 4.2,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.1,
          rate: 80,
          discount: 0.8,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 4,
          rate: 5,
          discount: 2,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-milling-1',
          quantity: 1,
          rate: 10,
          discount: 1
        }
      ],
      tax: 3.33,
      payment_amount: 75.33
    },
    'RCP-DYN/in-store/none/modified': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.08,
          rate: 80,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          tax_id: 'tax-zero'
        },
        {
          item_id: 'fee-makers-1',
          quantity: 1,
          rate: 45
        },
        {
          item_id: 'fee-materials-1',
          quantity: 1,
          rate: 5
        }
      ],
      tax: 4.22,
      payment_amount: 91.62
    },
    'RCP-DYN/take-out/type-recipe/modified': {
      line_items: [
        {
          item_id: 'ing-grain-1',
          quantity: 6,
          rate: 3.5,
          discount: 2.1,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-hop-1',
          quantity: 0.08,
          rate: 80,
          discount: 0.64,
          tax_id: 'tax-gst'
        },
        {
          item_id: 'ing-yeast-1',
          quantity: 2,
          rate: 5,
          discount: 1,
          tax_id: 'tax-zero'
        }
      ],
      tax: 1.23,
      payment_amount: 34.89
    }
  }
};
// ORACLE-END

module.exports = {
  FEE_IDS: FEE_IDS,
  MOCK_INGREDIENTS_CATALOG: MOCK_INGREDIENTS_CATALOG,
  MOCK_RECIPES: MOCK_RECIPES,
  KIOSK_FEE_CATALOG: KIOSK_FEE_CATALOG,
  DISCOUNT_PRESETS: DISCOUNT_PRESETS,
  DISCOUNT_KEYS: DISCOUNT_KEYS,
  ORACLE: ORACLE
};

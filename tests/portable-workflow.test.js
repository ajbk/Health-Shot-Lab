const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '..', 'HealthShotLab-Standalone.html');

function loadPortableApp({ now } = {}) {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'the standalone app must contain one inline script');

  const storage = new Map();
  const handlers = new Map();
  const elements = new Map();
  const elementLists = new Map();
  const elementFor = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        addEventListener: (event, handler) => handlers.set(`${selector}:${event}`, handler)
      });
    }
    return elements.get(selector);
  };
  const AppDate = now ? class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return new Date(now).valueOf();
    }
  } : Date;
  const context = {
    console,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { querySelector: elementFor, querySelectorAll: selector => elementLists.get(selector) || [] },
    window: {},
    Date: AppDate,
    Intl,
    Blob: class {},
    URL: {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  };

  vm.createContext(context);
  const code = scripts[0].replace(/\ninit\(\);\s*$/, '\n');
  new vm.Script(code, { filename: sourcePath }).runInContext(context);
  context.__handlers = handlers;
  context.__setElements = (selector, items) => elementLists.set(selector, items);
  return context;
}

function serialise(value) {
  return JSON.parse(JSON.stringify(value));
}

test('changing formula refreshes batch ingredient targets', () => {
  const app = loadPortableApp();
  vm.runInContext(`
    state.formulas = [
      { id: 1, target_volume_l: 5, ingredients: [{ name: 'Ginger', target_qty: 5, unit: 'kg' }] },
      { id: 2, target_volume_l: 5, ingredients: [{ name: 'Lemon', target_qty: 2, unit: 'L' }] }
    ];
    state.wizard = { formula_id: 1, target_volume_l: 5, ingredients: [], extractions: [] };
    hydrateIngredients();
  `, app);
  vm.runInContext('bindWizardFields()', app);
  app.__handlers.get('#wFormula:change')({ target: { value: '2' } });
  const ingredients = vm.runInContext('state.wizard.ingredients', app);

  assert.deepEqual(serialise(ingredients), [{ name: 'Lemon', target_qty: 2, actual_qty: 2, unit: 'L' }]);
});

test('backtracked draft updates its persisted formula before it can continue', async () => {
  const app = loadPortableApp();
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [{ name: 'Ginger', target_qty: 5, actual_qty: 5, unit: 'kg' }] }
  });

  vm.runInContext(`
    state.formulas = [
      { id: 1, target_volume_l: 5, ingredients: [{ name: 'Ginger', target_qty: 5, unit: 'kg' }] },
      { id: 2, target_volume_l: 5, ingredients: [{ name: 'Lemon', target_qty: 2, unit: 'L' }] }
    ];
    state.wizardStep = 1;
    state.wizard = {
      formula_id: 2,
      target_volume_l: 5,
      ingredients: [{ name: 'Lemon', target_qty: 2, actual_qty: 2, unit: 'L' }],
      extractions: [],
      batch_id: ${created.id}
    };
  `, app);
  await vm.runInContext('wizardNext()', app);

  const persisted = serialise(await app.api(`/api/batches/${created.id}`));
  assert.equal(persisted.formula_id, 2);
  assert.deepEqual(persisted.ingredients, [{ name: 'Lemon', target_qty: 2, actual_qty: 2, unit: 'L' }]);
});

test('new wizard persists its predicted bottle count before completion', () => {
  const app = loadPortableApp();
  const bottles = vm.runInContext(`
    state.wizard = freshWizard();
    state.wizard.actual_volume_l = 5;
    state.wizard.filling.bottle_size_ml = 60;
    stepFilling();
    state.wizard.filling.good_bottles;
  `, app);

  assert.equal(bottles, 83);
});

test('shelf-life dates retain the intended local calendar day in Bangkok', () => {
  const app = loadPortableApp();

  assert.equal(vm.runInContext("portableAddDays('2026-09-04', 0)", app), '2026-09-04');
  assert.equal(vm.runInContext("portableAddDays('2026-09-04', 7)", app), '2026-09-11');
});

test('completion uses the local date for the Day 0 checkpoint', async () => {
  const app = loadPortableApp({ now: new Date(2026, 8, 4, 0, 30).toISOString() });
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
  });
  await app.api(`/api/batches/${created.id}/complete`, {
    method: 'POST',
    body: {
      actual_volume_l: 5,
      extractions: [],
      qc: { ph: 3.2, brix: 8.5 },
      filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
      cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
    }
  });

  const checkpoints = serialise(await app.api('/api/shelf-life'));
  assert.equal(checkpoints[0].due_date, '2026-09-04');
});

test('blank QC readings remain unmeasured in dashboard aggregates', async () => {
  const app = loadPortableApp();
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
  });
  await app.api(`/api/batches/${created.id}/complete`, {
    method: 'POST',
    body: {
      actual_volume_l: 5,
      extractions: [],
      qc: { ph: '', brix: '', temperature_c: 4 },
      filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
      cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
    }
  });

  const dashboard = serialise(await app.api('/api/dashboard'));
  assert.equal(dashboard.recentBatches[0].ph, null);
  assert.equal(dashboard.recentBatches[0].brix, null);
  assert.equal(dashboard.kpis.ph, null);
  assert.equal(dashboard.kpis.brix, null);
});

test('unfinished extraction rows do not lower the saved batch yield', async () => {
  const app = loadPortableApp();
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
  });
  await app.api(`/api/batches/${created.id}/complete`, {
    method: 'POST',
    body: {
      actual_volume_l: 5,
      extractions: [
        { ingredient_name: 'Ginger', raw_input_kg: 5, juice_output_l: 2.5 },
        { ingredient_name: '', raw_input_kg: '', juice_output_l: '' }
      ],
      qc: { ph: 3.2, brix: 8.5 },
      filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
      cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
    }
  });

  const batch = serialise(await app.api(`/api/batches/${created.id}`));
  assert.equal(batch.avg_yield, 50);
  assert.equal(batch.extractions.length, 1);
});

test('raw-only extraction rows do not become measured zero-yield records', async () => {
  const app = loadPortableApp();
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
  });
  await app.api(`/api/batches/${created.id}/complete`, {
    method: 'POST',
    body: {
      actual_volume_l: 5,
      extractions: [
        { ingredient_name: 'Ginger', raw_input_kg: 5, juice_output_l: 2.5 },
        { ingredient_name: 'Lemon', raw_input_kg: 1, juice_output_l: '' }
      ],
      qc: { ph: 3.2, brix: 8.5 },
      filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
      cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
    }
  });

  const batch = serialise(await app.api(`/api/batches/${created.id}`));
  assert.equal(batch.avg_yield, 50);
  assert.equal(batch.extractions.length, 1);
});

test('clearing a juice field keeps the extraction unmeasured through completion', async () => {
  const app = loadPortableApp();
  let juiceHandler;
  const juiceInput = {
    dataset: { i: '1' },
    addEventListener: (event, handler) => {
      if (event === 'input') juiceHandler = handler;
    }
  };
  app.__setElements('.ex-juice', [juiceInput]);
  vm.runInContext(`
    state.wizard = {
      extractions: [
        { ingredient_name: 'Ginger', raw_input_kg: 5, juice_output_l: 2.5 },
        { ingredient_name: 'Lemon', raw_input_kg: 1, juice_output_l: 0.5 }
      ]
    };
    bindWizardFields();
  `, app);
  juiceHandler({ target: { dataset: { i: '1' }, value: '' } });

  const extractions = serialise(vm.runInContext('state.wizard.extractions', app));
  assert.equal(extractions[1].juice_output_l, '');
  const created = await app.api('/api/batches', {
    method: 'POST',
    body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
  });
  await app.api(`/api/batches/${created.id}/complete`, {
    method: 'POST',
    body: {
      actual_volume_l: 5,
      extractions,
      qc: { ph: 3.2, brix: 8.5 },
      filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
      cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
    }
  });

  const batch = serialise(await app.api(`/api/batches/${created.id}`));
  assert.equal(batch.avg_yield, 50);
  assert.equal(batch.extractions.length, 1);
});

test('shelf-life returns complete labelled checkpoints for four completed batches', async () => {
  const app = loadPortableApp();

  for (let index = 0; index < 4; index += 1) {
    const created = await app.api('/api/batches', {
      method: 'POST',
      body: { formula_id: 1, target_volume_l: 5, ingredients: [] }
    });
    await app.api(`/api/batches/${created.id}/complete`, {
      method: 'POST',
      body: {
        actual_volume_l: 5,
        extractions: [],
        qc: { ph: 3.2, brix: 8.5 },
        filling: { bottle_size_ml: 60, good_bottles: 80, reject_bottles: 0 },
        cost: { raw_material_cost: 300, packaging_cost: 100, utilities_cost: 0 }
      }
    });
  }

  const checkpoints = serialise(await app.api('/api/shelf-life'));
  assert.equal(checkpoints.length, 16);
  assert.equal(new Set(checkpoints.map(checkpoint => checkpoint.id)).size, 16);
  assert.ok(checkpoints.every(checkpoint => checkpoint.batch_code && checkpoint.formula_name));
  assert.equal(new Set(checkpoints.map(checkpoint => checkpoint.batch_code)).size, 4);
});

test('editing a formula updates the existing record without creating a duplicate', async () => {
  const app = loadPortableApp();

  const updated = await app.api('/api/formulas/1', {
    method: 'PATCH',
    body: {
      name: 'Ginger Basic Plus',
      version: 'v0.2',
      target_volume_l: 5,
      ingredients: [
        { name: 'Apple juice', target_qty: 3.5, unit: 'L', percent: 70 },
        { name: 'Ginger juice', target_qty: 1, unit: 'L', percent: 20 },
        { name: 'Lemon juice', target_qty: 0.5, unit: 'L', percent: 10 }
      ]
    }
  });

  assert.equal(updated.id, 1);
  const formulas = serialise(await app.api('/api/formulas'));
  assert.equal(formulas.length, 1);
  assert.equal(formulas[0].name, 'Ginger Basic Plus');
  assert.equal(formulas[0].version, 'v0.2');
});

test('formula percentages calculate ingredient quantities from target volume', () => {
  const app = loadPortableApp();
  const ingredients = vm.runInContext(`formulaIngredientsFromPercent([
    { name: 'Apple juice', target_qty: 3.95, unit: 'L', percent: 79 },
    { name: 'Ginger juice', target_qty: 0.85, unit: 'L', percent: 17 },
    { name: 'Lemon juice', target_qty: 0.2, unit: 'L', percent: 4 }
  ], 10)`, app);

  assert.deepEqual(serialise(ingredients), [
    { name: 'Apple juice', target_qty: 7.9, unit: 'L', percent: 79 },
    { name: 'Ginger juice', target_qty: 1.7, unit: 'L', percent: 17 },
    { name: 'Lemon juice', target_qty: 0.4, unit: 'L', percent: 4 }
  ]);
});

test('formula quantities calculate percentages from edited quantities', () => {
  const app = loadPortableApp();
  const ingredients = vm.runInContext(`formulaPercentagesFromQuantity([
    { name: 'Apple juice', target_qty: 3, unit: 'L', percent: 79 },
    { name: 'Ginger juice', target_qty: 1, unit: 'L', percent: 17 },
    { name: 'Lemon juice', target_qty: 1, unit: 'L', percent: 4 }
  ])`, app);

  assert.deepEqual(serialise(ingredients), [
    { name: 'Apple juice', target_qty: 3, unit: 'L', percent: 60 },
    { name: 'Ginger juice', target_qty: 1, unit: 'L', percent: 20 },
    { name: 'Lemon juice', target_qty: 1, unit: 'L', percent: 20 }
  ]);
});

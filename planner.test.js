'use strict';

const { parseRecipes, planFactory } = require('./planner.js');

// Minimal recipe set covering all test scenarios.
const RECIPE_TEXT = `
# Standard recipes
Cable (Constructor): Wire 60/min -> Cable 30/min
Wire (Constructor): Copper Ingot 15/min -> Wire 30/min
Copper Ingot (Smelter): Copper Ore 30/min -> Copper Ingot 30/min
Iron Ingot (Smelter): Iron Ore 30/min -> Iron Ingot 30/min
Iron Plate (Constructor): Iron Ingot 30/min -> Iron Plate 20/min
Iron Rod (Constructor): Iron Ingot 15/min -> Iron Rod 15/min
Screws (Constructor): Iron Rod 10/min -> Screws 40/min
Reinforced Iron Plate (Assembler): Iron Plate 30/min + Screws 60/min -> Reinforced Iron Plate 5/min
Circuit Board (Assembler): Copper Sheet 15/min + Plastic 30/min -> Circuit Board 7.5/min
Copper Sheet (Constructor): Copper Ingot 20/min -> Copper Sheet 10/min
Alumina Solution (Refinery): Bauxite 120/min + Water 180/min -> Alumina Solution 120/min + Silica 50/min
Aluminum Scrap (Refinery): Alumina Solution 240/min + Coal 120/min -> Aluminum Scrap 360/min + Water 120/min
Aluminum Ingot (Foundry): Aluminum Scrap 90/min + Silica 75/min -> Aluminum Ingot 60/min
Silica (Constructor): Raw Quartz 22.5/min -> Silica 37.5/min
Encased Uranium Cell (Blender): Uranium Ore 50/min + Concrete 15/min + Sulfuric Acid 40/min -> Encased Uranium Cell 25/min + Sulfuric Acid 10/min
Sulfuric Acid (Refinery): Sulfur 50/min + Water 50/min -> Sulfuric Acid 50/min
# Alt recipes
[Alt] Fused Wire (Assembler): Copper Ingot 12/min + Caterium Ingot 3/min -> Wire 90/min
[Alt] Recycled Plastic (Refinery): Rubber 30/min + Fuel 30/min -> Plastic 60/min
[Alt] Recycled Rubber (Refinery): Plastic 30/min + Fuel 30/min -> Rubber 60/min
`;

const ALL_MACHINES = ['Constructor', 'Smelter', 'Assembler', 'Refinery', 'Foundry', 'Blender'];
const ALL_ALTS = ['Fused Wire', 'Recycled Plastic', 'Recycled Rubber'];

const RECIPES = parseRecipes(RECIPE_TEXT);

// ── tiny test runner ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── tests ─────────────────────────────────────────────────────────────────────

console.log('planFactory tests\n');

test('returns empty floors with warning when no outputs given', () => {
  const { floors, warnings } = planFactory({
    recipes: RECIPES,
    imports: [],
    outputs: [],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  assertEqual(floors.length, 0);
  assert(warnings.length > 0, 'should have a warning');
});

test('single item with imported raw input produces one floor', () => {
  const { floors, warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore'],
    outputs: [{ item: 'Copper Ingot', rate: 30 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  assertEqual(floors.length, 1, 'should have exactly one floor');
  assertEqual(floors[0].product, 'Copper Ingot');
  assert(warnings.length === 0, `unexpected warnings: ${warnings}`);
});

test('floors ordered bottom-to-top: dependencies precede dependents', () => {
  // Cable chain: Copper Ore → Copper Ingot → Wire → Cable
  const { floors } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 30 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  const products = floors.map(f => f.product);
  assert(products.includes('Copper Ingot'), 'Copper Ingot floor missing');
  assert(products.includes('Wire'), 'Wire floor missing');
  assert(products.includes('Cable'), 'Cable floor missing');
  const ingotIdx = products.indexOf('Copper Ingot');
  const wireIdx = products.indexOf('Wire');
  const cableIdx = products.indexOf('Cable');
  assert(ingotIdx < wireIdx, 'Copper Ingot must come before Wire');
  assert(wireIdx < cableIdx, 'Wire must come before Cable');
  assertEqual(floors[cableIdx].num, cableIdx + 1, 'floor nums are 1-based');
});

test('correct machine count calculation', () => {
  // Need Cable 60/min. Cable recipe: Wire 60/min → Cable 30/min → need 2 machines.
  // Wire for 120/min: Wire recipe 30/min per machine → need 4 machines.
  const { floors } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 60 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  const cable = floors.find(f => f.product === 'Cable');
  const wire = floors.find(f => f.product === 'Wire');
  assertEqual(cable.machineCount, 2, 'Cable needs 2 machines for 60/min');
  assertEqual(wire.machineCount, 4, 'Wire needs 4 machines for 120/min');
});

test('imported items do not get a production floor', () => {
  // With Wire imported, only Cable needs a floor.
  const { floors } = planFactory({
    recipes: RECIPES,
    imports: ['Wire'],
    outputs: [{ item: 'Cable', rate: 30 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  const products = floors.map(f => f.product);
  assert(!products.includes('Wire'), 'Wire should not have a floor when imported');
  assertEqual(floors.length, 1);
  assertEqual(floors[0].product, 'Cable');
});

test('warning for item with no recipe and not imported', () => {
  // Plastic has no recipe in our minimal set, and is not imported.
  const { warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Sheet'],
    outputs: [{ item: 'Circuit Board', rate: 7.5 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  assert(
    warnings.some(w => w.includes('Plastic')),
    `expected warning about Plastic, got: ${warnings}`
  );
});

test('disabled machine excludes its recipes', () => {
  // Without Smelter, Copper Ingot has no recipe → warning.
  const { warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
    machines: ['Constructor'],
    altRecipes: [],
  });
  assert(
    warnings.some(w => w.includes('Copper Ingot')),
    `expected warning about Copper Ingot when Smelter disabled, got: ${warnings}`
  );
});

test('alt recipe only used when explicitly enabled', () => {
  // Without Fused Wire in altRecipes, Wire floor should use standard Constructor recipe.
  const { floors: floorsStd } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  const wireStd = floorsStd.find(f => f.product === 'Wire');
  assertEqual(wireStd.recipe.name, 'Wire', 'standard recipe should be used');

  // With Fused Wire enabled and choosing it via choices:
  const { floors: floorsAlt } = planFactory({
    recipes: RECIPES,
    imports: ['Copper Ore', 'Caterium Ingot'],
    outputs: [{ item: 'Wire', rate: 90 }],
    machines: ALL_MACHINES,
    altRecipes: ['Fused Wire'],
    choices: { Wire: 'Fused Wire' },
  });
  const wireAlt = floorsAlt.find(f => f.product === 'Wire');
  assertEqual(wireAlt.recipe.name, 'Fused Wire', 'alt recipe should be used when enabled');
});

test('byproducts listed on floor but not given their own floor', () => {
  // Alumina Solution produces Silica as byproduct.
  const { floors } = planFactory({
    recipes: RECIPES,
    imports: ['Bauxite', 'Water'],
    outputs: [{ item: 'Alumina Solution', rate: 120 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  const aluminaFloor = floors.find(f => f.product === 'Alumina Solution');
  assert(aluminaFloor.byproducts.some(b => b.item === 'Silica'), 'Silica should be a byproduct');
  assert(!floors.some(f => f.product === 'Silica'), 'Silica should not have its own floor when only a byproduct');
});

test('aluminum chain: no false circular dependency when water is imported', () => {
  // Classic false-positive scenario: Aluminum Scrap emits Water as byproduct.
  // OLD bug: BY_OUTPUT["Water"] included Aluminum Scrap → Water→Alumina Solution→Water cycle.
  // FIX: only primary outputs indexed → Water is not routed through Aluminum Scrap.
  const { floors, warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Bauxite', 'Coal', 'Water', 'Raw Quartz'],
    outputs: [{ item: 'Aluminum Ingot', rate: 60 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  assert(
    !warnings.some(w => w.includes('Circular')),
    `unexpected circular dependency: ${warnings}`
  );
  const products = floors.map(f => f.product);
  // Silica must be produced before Aluminum Ingot (Aluminum Ingot needs Silica).
  const silicaIdx = products.indexOf('Silica');
  const ingotIdx = products.indexOf('Aluminum Ingot');
  assert(silicaIdx !== -1, 'Silica floor should exist');
  assert(silicaIdx < ingotIdx, 'Silica must come before Aluminum Ingot');
});

test('net-consumption recipe (Encased Uranium Cell) does not create self-loop', () => {
  // Encased Uranium Cell consumes Sulfuric Acid AND emits it as byproduct.
  // A self-loop would incorrectly flag Encased Uranium Cell as cyclic.
  const { warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Uranium Ore', 'Concrete', 'Sulfur', 'Water'],
    outputs: [{ item: 'Encased Uranium Cell', rate: 25 }],
    machines: ALL_MACHINES,
    altRecipes: [],
  });
  assert(
    !warnings.some(w => w.includes('Circular')),
    `unexpected circular dependency: ${warnings}`
  );
});

test('real mutual dependency (Recycled Plastic/Rubber) reports cycle warning', () => {
  // This IS a real cycle: Recycled Plastic needs Rubber, Recycled Rubber needs Plastic.
  // The planner should warn about it rather than crash or silently mis-order.
  const { warnings } = planFactory({
    recipes: RECIPES,
    imports: ['Fuel'],
    outputs: [{ item: 'Plastic', rate: 60 }],
    machines: ALL_MACHINES,
    altRecipes: ['Recycled Plastic', 'Recycled Rubber'],
    choices: { Plastic: 'Recycled Plastic', Rubber: 'Recycled Rubber' },
  });
  assert(
    warnings.some(w => w.includes('Circular')),
    `expected circular dependency warning, got: ${warnings}`
  );
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

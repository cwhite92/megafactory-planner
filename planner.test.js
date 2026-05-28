'use strict';

const { parseRecipes, planFactory } = require('./planner.js');

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
[Alt] Stitched Iron Plate (Assembler): Iron Plate 18.75/min + Wire 37.5/min -> Reinforced Iron Plate 5.625/min
[Alt] Recycled Plastic (Refinery): Rubber 30/min + Fuel 30/min -> Plastic 60/min
[Alt] Recycled Rubber (Refinery): Plastic 30/min + Fuel 30/min -> Rubber 60/min
`;

const ALL_RECIPES = parseRecipes(RECIPE_TEXT);
const BASE = ALL_RECIPES.filter(r => !r.isAlt);
const ALTS = ALL_RECIPES.filter(r => r.isAlt);

// Helper: build availableRecipes from recipe names
function pick(...names) {
  return ALL_RECIPES.filter(r => names.includes(r.name));
}

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
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function plan(opts) {
  return planFactory({ availableRecipes: BASE, ...opts });
}

// ── tests ─────────────────────────────────────────────────────────────────────
console.log('planFactory tests\n');

test('returns empty floors with warning when no outputs given', () => {
  const { floors, warnings } = plan({ imports: [], outputs: [] });
  assertEqual(floors.length, 0);
  assert(warnings.length > 0, 'should warn');
});

test('single item with imported raw input produces one floor', () => {
  const { floors, warnings } = plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Copper Ingot', rate: 30 }],
  });
  assertEqual(floors.length, 1);
  assertEqual(floors[0].product, 'Copper Ingot');
  assert(!warnings.length, `unexpected warnings: ${warnings}`);
});

test('floors ordered bottom-to-top: dependencies precede dependents', () => {
  const { floors } = plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  const idx = name => floors.findIndex(f => f.product === name);
  assert(idx('Copper Ingot') < idx('Wire'), 'Copper Ingot before Wire');
  assert(idx('Wire') < idx('Cable'), 'Wire before Cable');
  assertEqual(floors[idx('Cable')].num, idx('Cable') + 1, 'floor nums are 1-based');
});

test('correct machine count calculation', () => {
  const { floors } = plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 60 }],
  });
  const cable = floors.find(f => f.product === 'Cable');
  const wire  = floors.find(f => f.product === 'Wire');
  assertEqual(cable.machineCount, 2,  'Cable needs 2 machines for 60/min');
  assertEqual(wire.machineCount,  4,  'Wire needs 4 machines for 120/min');
});

test('imported items do not get a production floor', () => {
  const { floors } = plan({
    imports: ['Wire'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  assert(!floors.some(f => f.product === 'Wire'), 'Wire should not have a floor when imported');
  assertEqual(floors.length, 1);
});

test('warning for item with no available recipe and not imported', () => {
  // Circuit Board needs Plastic; Plastic has no recipe in BASE
  const { warnings } = plan({
    imports: ['Copper Sheet'],
    outputs: [{ item: 'Circuit Board', rate: 7.5 }],
  });
  assert(warnings.some(w => w.includes('Plastic')), `expected Plastic warning, got: ${warnings}`);
});

test('excluding a recipe removes it from planning', () => {
  // Without Copper Ingot recipe, Wire (needs Copper Ingot) should warn about Copper Ingot
  const { warnings } = planFactory({
    availableRecipes: pick('Cable', 'Wire'),
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
  });
  assert(
    warnings.some(w => w.includes('Copper Ingot')),
    `expected Copper Ingot warning when its recipe is excluded, got: ${warnings}`
  );
});

test('byproducts listed on floor but not given their own floor', () => {
  const { floors } = plan({
    imports: ['Bauxite', 'Water'],
    outputs: [{ item: 'Alumina Solution', rate: 120 }],
  });
  const aluminaFloor = floors.find(f => f.product === 'Alumina Solution');
  assert(aluminaFloor.byproducts.some(b => b.item === 'Silica'), 'Silica should be a byproduct');
  assert(!floors.some(f => f.product === 'Silica'), 'Silica should not get its own floor');
});

test('aluminum chain: no false circular dependency when water is imported', () => {
  const { floors, warnings } = plan({
    imports: ['Bauxite', 'Coal', 'Water', 'Raw Quartz'],
    outputs: [{ item: 'Aluminum Ingot', rate: 60 }],
  });
  assert(!warnings.some(w => w.includes('Circular')), `unexpected cycle: ${warnings}`);
  const products = floors.map(f => f.product);
  assert(products.indexOf('Silica') < products.indexOf('Aluminum Ingot'), 'Silica before Aluminum Ingot');
});

test('net-consumption recipe (Encased Uranium Cell) does not create self-loop', () => {
  const { warnings } = plan({
    imports: ['Uranium Ore', 'Concrete', 'Sulfur', 'Water'],
    outputs: [{ item: 'Encased Uranium Cell', rate: 25 }],
  });
  assert(!warnings.some(w => w.includes('Circular')), `unexpected cycle: ${warnings}`);
});

test('real mutual dependency (Recycled Plastic/Rubber) reports cycle warning', () => {
  const { warnings } = planFactory({
    availableRecipes: pick('Recycled Plastic', 'Recycled Rubber'),
    imports: ['Fuel'],
    outputs: [{ item: 'Plastic', rate: 60 }],
  });
  assert(warnings.some(w => w.includes('Circular')), `expected cycle warning, got: ${warnings}`);
});

test('best-recipe heuristic: prefers recipe that uses already-planned inputs', () => {
  // Factory needs both Cable and Reinforced Iron Plate.
  // Cable needs Wire → Wire goes into `rates` first.
  // When the planner reaches Reinforced Iron Plate it has two options:
  //   Standard:       Iron Plate + Screws  (Screws not in plan → 1 new floor if Iron Plate already planned)
  //   Stitched Iron Plate: Iron Plate + Wire   (Wire IS already in plan  → 0 new inputs if Iron Plate already planned)
  // Stitched should win because Wire is already needed.
  const { floors } = planFactory({
    availableRecipes: pick(
      'Cable', 'Wire', 'Copper Ingot',
      'Reinforced Iron Plate', 'Stitched Iron Plate',
      'Iron Plate', 'Iron Ingot', 'Iron Rod', 'Screws'
    ),
    imports: ['Copper Ore', 'Iron Ore'],
    outputs: [
      { item: 'Cable', rate: 30 },
      { item: 'Reinforced Iron Plate', rate: 5 },
    ],
  });
  const rip = floors.find(f => f.product === 'Reinforced Iron Plate');
  assert(rip, 'Reinforced Iron Plate floor should exist');
  assertEqual(rip.recipe.name, 'Stitched Iron Plate', 'should prefer Stitched (uses Wire already in plan)');
  assert(!floors.some(f => f.product === 'Screws'), 'Screws floor should not exist when Stitched is chosen');
  assert(!floors.some(f => f.product === 'Iron Rod'), 'Iron Rod floor should not exist when Stitched is chosen');
});

test('best-recipe heuristic tiebreak: without context, prefers higher output rate', () => {
  // Only Reinforced Iron Plate needed; neither Wire nor Screws is already in plan.
  // Standard: Iron Plate + Screws → RIP 5/min
  // Stitched:  Iron Plate + Wire  → RIP 5.625/min  ← higher rate wins tiebreak
  const { floors } = planFactory({
    availableRecipes: pick(
      'Reinforced Iron Plate', 'Stitched Iron Plate',
      'Iron Plate', 'Iron Ingot', 'Iron Rod', 'Screws',
      'Wire', 'Copper Ingot'
    ),
    imports: ['Iron Ore', 'Copper Ore'],
    outputs: [{ item: 'Reinforced Iron Plate', rate: 5 }],
  });
  const rip = floors.find(f => f.product === 'Reinforced Iron Plate');
  assertEqual(rip.recipe.name, 'Stitched Iron Plate', 'higher output rate wins tiebreak');
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

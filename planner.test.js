'use strict';

const { planFactory } = require('./planner.js');

function r(name, machine, isAlt, inputs, outputs) {
  return { name, machine, isAlt, icon: null, inputs, outputs };
}
function io(item, rate) { return { item, rate }; }

const ALL_RECIPES = [
  r('Cable',                  'Constructor', false, [io('Wire', 60)],                                          [io('Cable', 30)]),
  r('Wire',                   'Constructor', false, [io('Copper Ingot', 15)],                                  [io('Wire', 30)]),
  r('Copper Ingot',           'Smelter',     false, [io('Copper Ore', 30)],                                    [io('Copper Ingot', 30)]),
  r('Iron Ingot',             'Smelter',     false, [io('Iron Ore', 30)],                                      [io('Iron Ingot', 30)]),
  r('Iron Plate',             'Constructor', false, [io('Iron Ingot', 30)],                                    [io('Iron Plate', 20)]),
  r('Iron Rod',               'Constructor', false, [io('Iron Ingot', 15)],                                    [io('Iron Rod', 15)]),
  r('Screws',                 'Constructor', false, [io('Iron Rod', 10)],                                      [io('Screws', 40)]),
  r('Reinforced Iron Plate',  'Assembler',   false, [io('Iron Plate', 30), io('Screws', 60)],                  [io('Reinforced Iron Plate', 5)]),
  r('Circuit Board',          'Assembler',   false, [io('Copper Sheet', 15), io('Plastic', 30)],               [io('Circuit Board', 7.5)]),
  r('Copper Sheet',           'Constructor', false, [io('Copper Ingot', 20)],                                  [io('Copper Sheet', 10)]),
  r('Alumina Solution',       'Refinery',    false, [io('Bauxite', 120), io('Water', 180)],                    [io('Alumina Solution', 120), io('Silica', 50)]),
  r('Aluminum Scrap',         'Refinery',    false, [io('Alumina Solution', 240), io('Coal', 120)],            [io('Aluminum Scrap', 360), io('Water', 120)]),
  r('Aluminum Ingot',         'Foundry',     false, [io('Aluminum Scrap', 90), io('Silica', 75)],              [io('Aluminum Ingot', 60)]),
  r('Silica',                 'Constructor', false, [io('Raw Quartz', 22.5)],                                  [io('Silica', 37.5)]),
  r('Encased Uranium Cell',   'Blender',     false, [io('Uranium Ore', 50), io('Concrete', 15), io('Sulfuric Acid', 40)], [io('Encased Uranium Cell', 25), io('Sulfuric Acid', 10)]),
  r('Sulfuric Acid',          'Refinery',    false, [io('Sulfur', 50), io('Water', 50)],                       [io('Sulfuric Acid', 50)]),
  r('Fused Wire',             'Assembler',   true,  [io('Copper Ingot', 12), io('Caterium Ingot', 3)],         [io('Wire', 90)]),
  r('Stitched Iron Plate',    'Assembler',   true,  [io('Iron Plate', 18.75), io('Wire', 37.5)],               [io('Reinforced Iron Plate', 5.625)]),
  r('Recycled Plastic',       'Refinery',    true,  [io('Rubber', 30), io('Fuel', 30)],                        [io('Plastic', 60)]),
  r('Recycled Rubber',        'Refinery',    true,  [io('Plastic', 30), io('Fuel', 30)],                       [io('Rubber', 60)]),
];

const BASE = ALL_RECIPES.filter(r => !r.isAlt);
const ALTS = ALL_RECIPES.filter(r => r.isAlt);

// Helper: build availableRecipes from recipe names
function pick(...names) {
  return ALL_RECIPES.filter(r => names.includes(r.name));
}

// ── tiny test runner ──────────────────────────────────────────────────────────
// planFactory is async (the ILP solver initialises its WASM backend
// asynchronously), so tests register an async fn and are awaited in sequence.
let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
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

test('returns empty floors with warning when no outputs given', async () => {
  const { floors, warnings } = await plan({ imports: [], outputs: [] });
  assertEqual(floors.length, 0);
  assert(warnings.length > 0, 'should warn');
});

test('single item with imported raw input produces one floor', async () => {
  const { floors, warnings } = await plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Copper Ingot', rate: 30 }],
  });
  assertEqual(floors.length, 1);
  assertEqual(floors[0].product, 'Copper Ingot');
  assert(!warnings.length, `unexpected warnings: ${warnings}`);
});

test('floors ordered bottom-to-top: dependencies precede dependents', async () => {
  const { floors } = await plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  const idx = name => floors.findIndex(f => f.product === name);
  assert(idx('Copper Ingot') < idx('Wire'), 'Copper Ingot before Wire');
  assert(idx('Wire') < idx('Cable'), 'Wire before Cable');
  assertEqual(floors[idx('Cable')].num, idx('Cable') + 1, 'floor nums are 1-based');
});

test('correct machine count calculation', async () => {
  const { floors } = await plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 60 }],
  });
  const cable = floors.find(f => f.product === 'Cable');
  const wire  = floors.find(f => f.product === 'Wire');
  assertEqual(cable.machineCount, 2,  'Cable needs 2 machines for 60/min');
  assertEqual(wire.machineCount,  4,  'Wire needs 4 machines for 120/min');
});

test('imported items do not get a production floor', async () => {
  const { floors } = await plan({
    imports: ['Wire'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  assert(!floors.some(f => f.product === 'Wire'), 'Wire should not have a floor when imported');
  assertEqual(floors.length, 1);
});

test('warning for item with no available recipe and not imported', async () => {
  // Circuit Board needs Plastic; Plastic has no recipe in BASE
  const { warnings } = await plan({
    imports: ['Copper Sheet'],
    outputs: [{ item: 'Circuit Board', rate: 7.5 }],
  });
  assert(warnings.some(w => w.includes('Plastic')), `expected Plastic warning, got: ${warnings}`);
});

test('excluding a recipe removes it from planning', async () => {
  // Without Copper Ingot recipe, Wire (needs Copper Ingot) should warn about Copper Ingot
  const { warnings } = await planFactory({
    availableRecipes: pick('Cable', 'Wire'),
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
  });
  assert(
    warnings.some(w => w.includes('Copper Ingot')),
    `expected Copper Ingot warning when its recipe is excluded, got: ${warnings}`
  );
});

test('byproducts listed on floor but not given their own floor', async () => {
  const { floors } = await plan({
    imports: ['Bauxite', 'Water'],
    outputs: [{ item: 'Alumina Solution', rate: 120 }],
  });
  const aluminaFloor = floors.find(f => f.product === 'Alumina Solution');
  assert(aluminaFloor.byproducts.some(b => b.item === 'Silica'), 'Silica should be a byproduct');
  assert(!floors.some(f => f.product === 'Silica'), 'Silica should not get its own floor');
});

test('aluminum chain: no false circular dependency when water is imported', async () => {
  const { floors, warnings } = await plan({
    imports: ['Bauxite', 'Coal', 'Water', 'Raw Quartz'],
    outputs: [{ item: 'Aluminum Ingot', rate: 60 }],
  });
  assert(!warnings.some(w => w.includes('Circular')), `unexpected cycle: ${warnings}`);
  const products = floors.map(f => f.product);
  assert(products.indexOf('Silica') < products.indexOf('Aluminum Ingot'), 'Silica before Aluminum Ingot');
});

test('net-consumption recipe (Encased Uranium Cell) does not create self-loop', async () => {
  const { warnings } = await plan({
    imports: ['Uranium Ore', 'Concrete', 'Sulfur', 'Water'],
    outputs: [{ item: 'Encased Uranium Cell', rate: 25 }],
  });
  assert(!warnings.some(w => w.includes('Circular')), `unexpected cycle: ${warnings}`);
});

test('real mutual dependency (Recycled Plastic/Rubber) reports cycle warning', async () => {
  const { warnings } = await planFactory({
    availableRecipes: pick('Recycled Plastic', 'Recycled Rubber'),
    imports: ['Fuel'],
    outputs: [{ item: 'Plastic', rate: 60 }],
  });
  assert(warnings.some(w => w.includes('Circular')), `expected cycle warning, got: ${warnings}`);
});

test('best-recipe heuristic: prefers recipe that uses already-planned inputs', async () => {
  // Factory needs both Cable and Reinforced Iron Plate.
  // Cable needs Wire → Wire goes into `rates` first.
  // When the planner reaches Reinforced Iron Plate it has two options:
  //   Standard:       Iron Plate + Screws  (Screws not in plan → 1 new floor if Iron Plate already planned)
  //   Stitched Iron Plate: Iron Plate + Wire   (Wire IS already in plan  → 0 new inputs if Iron Plate already planned)
  // Stitched should win because Wire is already needed.
  const { floors } = await planFactory({
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

test('best-recipe heuristic tiebreak: without context, prefers higher output rate', async () => {
  // Only Reinforced Iron Plate needed; neither Wire nor Screws is already in plan.
  // Standard: Iron Plate + Screws → RIP 5/min
  // Stitched:  Iron Plate + Wire  → RIP 5.625/min  ← higher rate wins tiebreak
  const { floors } = await planFactory({
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

test('adding an intermediate as an explicit output does not change recipe choices', async () => {
  // Reinforced Iron Plate is needed by both Cable (indirectly, no) — use a setup
  // where Wire is an intermediate for Cable, and also happens to feed Stitched Iron Plate.
  // Whether or not Wire is listed as a desired output, the recipe choices should be identical.
  const recipes = pick(
    'Cable', 'Wire', 'Copper Ingot',
    'Reinforced Iron Plate', 'Stitched Iron Plate',
    'Iron Plate', 'Iron Ingot', 'Iron Rod', 'Screws'
  );
  const baseOutputs = [
    { item: 'Cable', rate: 30 },
    { item: 'Reinforced Iron Plate', rate: 5 },
  ];
  const withWireOutput = [
    ...baseOutputs,
    { item: 'Wire', rate: 10 },
  ];
  const { floors: floorsWithout } = await planFactory({ availableRecipes: recipes, imports: ['Copper Ore', 'Iron Ore'], outputs: baseOutputs });
  const { floors: floorsWith }    = await planFactory({ availableRecipes: recipes, imports: ['Copper Ore', 'Iron Ore'], outputs: withWireOutput });

  const recipeWithout = floorsWithout.find(f => f.product === 'Reinforced Iron Plate')?.recipe.name;
  const recipeWith    = floorsWith.find(f => f.product === 'Reinforced Iron Plate')?.recipe.name;
  assertEqual(recipeWith, recipeWithout, 'recipe choice for RIP should be the same regardless of whether Wire is an explicit output');
});

test('outputRate for intermediate floors matches actual demand from consumers', async () => {
  // Wire is an intermediate for Cable AND listed as a desired output.
  // If DFS processes Wire before Cable has added its Wire demand, Wire's outputRate
  // would be under-counted while Cable's inputs would show the correct (higher) rate.
  // After the fix, both must agree.
  const { floors } = await planFactory({
    availableRecipes: pick('Cable', 'Wire', 'Copper Ingot'),
    imports: ['Copper Ore'],
    outputs: [
      { item: 'Cable', rate: 60 },  // needs 120/min Wire
      { item: 'Wire',  rate: 30 },  // additional 30/min direct demand
    ],
  });
  const wire  = floors.find(f => f.product === 'Wire');
  const cable = floors.find(f => f.product === 'Cable');
  assert(wire && cable, 'Wire and Cable floors must exist');

  // Cable needs 2×Wire per output: 60/min Cable → 120/min Wire consumed by Cable.
  // Plus 30/min direct Wire output = 150/min total Wire rate.
  assertEqual(wire.outputRate, 150, 'Wire outputRate should be 150/min (120 for Cable + 30 direct)');

  // Cable's Wire input must equal Wire's outputRate minus the direct Wire demand.
  const cableWireInput = cable.inputs.find(i => i.item === 'Wire');
  assert(cableWireInput, 'Cable floor must list Wire as an input');
  assertEqual(cableWireInput.rate, 120, "Cable's Wire input rate should be 120/min");

  // The producing floor's outputRate must cover the consumer's demand.
  assert(wire.outputRate >= cableWireInput.rate, 'Wire outputRate must cover Cable demand');
});

test('beltSettings: adds belt info to floor outputs, inputs, and importedItems', async () => {
  // Cable 30/min → Wire 60/min → Copper Ingot 30/min → Copper Ore 30/min (imported)
  const { floors, importedItems } = await planFactory({
    availableRecipes: pick('Cable', 'Wire', 'Copper Ingot'),
    beltSettings: { beltMark: 6, beltUniform: false },
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  const cable = floors.find(f => f.product === 'Cable');
  // 30/min fits on 1×MK1 (cap 60)
  assert(cable.outputBelts != null, 'outputBelts should be set');
  assertEqual(cable.outputBelts.count, 1);
  assertEqual(cable.outputBelts.mark, 1);
  // Wire input to Cable is 60/min → exactly fills 1×MK1
  const wireInp = cable.inputs.find(i => i.item === 'Wire');
  assert(wireInp.belts != null, 'input belts should be set');
  assertEqual(wireInp.belts.count, 1);
  assertEqual(wireInp.belts.mark, 1);
  // Copper Ore is imported at 30/min total → 1×MK1
  const copperOre = importedItems.find(i => i.item === 'Copper Ore');
  assert(copperOre, 'Copper Ore should appear in importedItems');
  assertEqual(copperOre.belts.count, 1);
  assertEqual(copperOre.belts.mark, 1);
});

test('beltSettings: null belt fields when beltSettings omitted', async () => {
  const { floors, importedItems } = await plan({
    imports: ['Copper Ore'],
    outputs: [{ item: 'Cable', rate: 30 }],
  });
  const cable = floors.find(f => f.product === 'Cable');
  assertEqual(cable.outputBelts, null, 'outputBelts should be null without beltSettings');
  assert(cable.inputs.every(i => i.belts === null), 'input belts should be null without beltSettings');
  assert(importedItems.every(i => i.belts === null), 'importedItems belts should be null without beltSettings');
});

test('availableMachines filters out recipes whose machine is disabled', async () => {
  // Wire is made in a Constructor; disabling Constructor means no Wire recipe is available.
  const { warnings } = await planFactory({
    availableRecipes: BASE,
    availableMachines: ['Smelter', 'Assembler', 'Refinery', 'Foundry', 'Blender'],
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
  });
  assert(warnings.some(w => w.includes('Wire')), `expected Wire warning when Constructor is disabled, got: ${warnings}`);
});

test('ILP finds the globally-fewest-floors plan a greedy heuristic would miss', async () => {
  // Two desired outputs, Alpha and Beta, that can share an intermediate "Shared".
  //
  //   Alpha (solo) : Solo  -> Alpha 30   (high output rate)
  //   Alpha (share): Shared -> Alpha 10  (low output rate)
  //   Beta  (share): Shared -> Beta  10  (the only way to make Beta)
  //   Solo         : Solo Raw  -> Solo
  //   Shared       : Shared Raw -> Shared
  //
  // A greedy planner processing Alpha first sees two recipes that each introduce
  // one new intermediate (Solo vs Shared) — a tie it breaks on output rate, so it
  // picks "Alpha (solo)" (30 > 10). Beta then forces "Shared" anyway, leaving BOTH
  // Solo and Shared built: 4 production floors (Alpha, Solo, Beta, Shared).
  //
  // The ILP minimises total floors globally: choosing "Alpha (share)" lets Alpha
  // and Beta share the one Shared floor, dropping Solo entirely → 3 floors.
  const recipes = [
    r('Alpha (solo)',  'Assembler', false, [io('Solo', 30)],       [io('Alpha', 30)]),
    r('Alpha (share)', 'Assembler', true,  [io('Shared', 10)],     [io('Alpha', 10)]),
    r('Beta (share)',  'Assembler', false, [io('Shared', 10)],     [io('Beta', 10)]),
    r('Solo',          'Constructor', false, [io('Solo Raw', 30)], [io('Solo', 30)]),
    r('Shared',        'Constructor', false, [io('Shared Raw', 20)], [io('Shared', 20)]),
  ];
  const { floors, warnings } = await planFactory({
    availableRecipes: recipes,
    imports: ['Solo Raw', 'Shared Raw'],
    outputs: [{ item: 'Alpha', rate: 10 }, { item: 'Beta', rate: 10 }],
  });
  assert(!warnings.length, `unexpected warnings: ${warnings}`);

  const alpha = floors.find(f => f.product === 'Alpha');
  assert(alpha, 'Alpha floor should exist');
  assertEqual(alpha.recipe.name, 'Alpha (share)', 'ILP should pick the sharing recipe for Alpha');

  // The shared intermediate is built once and feeds both products; Solo is dropped.
  assert(floors.some(f => f.product === 'Shared'), 'Shared floor should exist');
  assert(!floors.some(f => f.product === 'Solo'), 'Solo floor should NOT exist — sharing makes it unnecessary');
  assertEqual(floors.length, 3, 'optimal plan has 3 floors (Alpha, Beta, Shared), not the greedy 4');

  // Shared must supply both consumers: Alpha needs 10/min, Beta needs 10/min = 20/min.
  const shared = floors.find(f => f.product === 'Shared');
  assertEqual(shared.outputRate, 20, 'Shared output must cover Alpha (10) + Beta (10)');
});

test('avoids an alt recipe whose input cannot be sourced when a clean recipe exists', async () => {
  // Fused Wire (Wire 90/min) needs Caterium Ingot — but no recipe makes it and it
  // isn't imported. Standard Wire (Wire 30/min, only Copper Ingot) is fully
  // sourceable. Fused Wire would need fewer machines, so a planner that ignored
  // the unsourceable input would wrongly pick it. The ILP must pick standard Wire
  // and raise no warning, because the phantom Caterium Ingot carries a heavy
  // penalty that outweighs the machine saving.
  const { floors, warnings } = await planFactory({
    availableRecipes: pick('Wire', 'Fused Wire', 'Copper Ingot'),
    imports: ['Copper Ore'],
    outputs: [{ item: 'Wire', rate: 30 }],
  });
  const wire = floors.find(f => f.product === 'Wire');
  assert(wire, 'Wire floor should exist');
  assertEqual(wire.recipe.name, 'Wire', 'should pick the fully-sourceable standard Wire, not Fused Wire');
  assert(!floors.some(f => f.product === 'Caterium Ingot'), 'no Caterium Ingot floor');
  assert(!warnings.length, `expected no warnings, got: ${warnings}`);
});

test('still builds a desired output when only a deep ingredient is unsourceable', async () => {
  // Circuit Board (desired) needs Plastic, which has no recipe in BASE and is not
  // imported. The planner must still build the Circuit Board floor and warn about
  // the missing Plastic specifically — NOT silently drop the desired product and
  // warn about Circuit Board itself.
  const { floors, warnings } = await plan({
    imports: ['Copper Sheet'],
    outputs: [{ item: 'Circuit Board', rate: 7.5 }],
  });
  assert(floors.some(f => f.product === 'Circuit Board'), 'Circuit Board floor should still be built');
  assert(warnings.some(w => w.includes('Plastic')), `expected Plastic warning, got: ${warnings}`);
  assert(!warnings.some(w => w.includes('Circuit Board')), `should not warn about the desired output itself, got: ${warnings}`);
});

// ── summary ───────────────────────────────────────────────────────────────────
runTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});

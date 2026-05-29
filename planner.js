'use strict';

const BELT_MARKS = [
  { mark: 1, capacity: 60 },
  { mark: 2, capacity: 120 },
  { mark: 3, capacity: 270 },
  { mark: 4, capacity: 480 },
  { mark: 5, capacity: 780 },
  { mark: 6, capacity: 1200 },
];

function calcBelts(rate, beltMark, beltUniform) {
  if (rate <= 0) return { count: 0, mark: 1 };
  const chosen = BELT_MARKS.find(b => b.mark === beltMark);
  if (beltUniform) return { count: Math.ceil(rate / chosen.capacity), mark: chosen.mark };
  const available = BELT_MARKS.filter(b => b.mark <= beltMark);
  const single = available.find(b => b.capacity >= rate);
  if (single) return { count: 1, mark: single.mark };
  return { count: Math.ceil(rate / chosen.capacity), mark: chosen.mark };
}

// ── GLPK solver loader ──────────────────────────────────────────────────────
// glpk.js initialises its WASM module asynchronously, so the solver instance is
// resolved once and cached.  In Node we use the synchronous-solve "node" build;
// in the browser the default build (web worker) is used.  Either way solve() is
// awaited, which is why planFactory is async.
let _glpkPromise = null;
function getGLPK() {
  if (_glpkPromise) return _glpkPromise;
  const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
  if (isNode) {
    // Node: synchronous-solve build, imported lazily (ESM-only package).
    _glpkPromise = import(/* @vite-ignore */ 'glpk.js/node').then(m => (m.default || m)());
  } else {
    // Browser: the GLPK factory is published as a global by a bundled module
    // script in index.html (planner.js itself is a classic script, so it can't
    // import the ESM package directly). Wait for that global, then instantiate.
    _glpkPromise = (async () => {
      for (let i = 0; i < 400 && !globalThis.__GLPK_FACTORY__; i++) {
        await new Promise(res => setTimeout(res, 25));
      }
      const factory = globalThis.__GLPK_FACTORY__;
      if (typeof factory !== 'function') throw new Error('GLPK solver failed to load');
      return factory();
    })();
  }
  return _glpkPromise;
}

const EPS = 1e-6;

// Plans a megafactory layout by solving an Integer Linear Program.
//
// params:
//   availableRecipes - recipe objects already filtered to the user's selection;
//                      when multiple recipes produce the same item the solver
//                      picks the best one as part of the optimisation.
//   imports          - string[] of items fed in from outside (no production floor)
//   outputs          - {item, rate}[] of desired factory products
//
// ILP formulation
// ───────────────
// Decision variables, per available recipe r:
//   x[r] >= 0  (continuous)  number of machines running that recipe
//   b[r] in {0,1}            whether the recipe is used at all
//
// Constraints:
//   1. At most one recipe per item:   sum(b[r] : r produces item) <= 1
//   2. Big-M linking:                 x[r] <= M[r] * b[r]
//      M[r] is a per-recipe upper bound on machine count (see computeMaxMachines).
//      A *tight* per-recipe M is essential: GLPK's integer feasibility tolerance
//      (~1e-5) lets b round to 0 when x/M is tiny, which would make adding a
//      recipe look "free" and defeat the fewest-floors objective.  Keeping M
//      close to the real machine count keeps x/M well above that tolerance.
//   3. Supply >= demand, per non-imported item that has a producer:
//        sum(x[r]*out_rate(r,item) : r produces item)
//          - sum(x[r]*in_rate(r,item) : r consumes item)  >=  desired_rate(item)
//
// Objective (minimise, weighted by priority):
//   1e6 * sum(b[r])                          fewest floors        (priority 1)
//   + 1 * sum(x[r])                          fewest machines      (priority 2)
//   + 0.001 * sum(x[r]*in_rate over inputs)  least belt traffic   (priority 3)
//
// "Produces item" means the recipe's PRIMARY output (outputs[0]) only — byproducts
// are listed on floors but never indexed as a production source.  This mirrors the
// original BY_OUTPUT design and prevents false cycles (e.g. Aluminum Scrap emits
// Water as a byproduct; treating that as a Water source would route Water through
// Aluminum Scrap and create a spurious loop).
//
// returns { floors, warnings, rates, importedItems }
//   floors  - ordered bottom-to-top (floor 1 first):
//             { num, product, recipe, machineCount, outputRate, outputBelts,
//               isDesired, inputs, byproducts }
//   warnings - string[]
//   rates    - { [item]: number } items/min produced across the whole plan
async function planFactory({
  availableRecipes,
  availableMachines = null,
  beltSettings = null,
  imports: importList = [],
  outputs: desiredOutputs = [],
}) {
  if (availableMachines != null) {
    const machineSet = new Set(availableMachines);
    availableRecipes = availableRecipes.filter(r => machineSet.has(r.machine));
  }
  const imp = new Set(importList);
  const warnings = [];
  const warnedItems = new Set();

  function warn(msg, key) {
    if (warnedItems.has(key)) return;
    warnedItems.add(key);
    warnings.push(msg);
  }

  if (!desiredOutputs.length) {
    return { floors: [], warnings: ['No desired outputs configured.'], rates: {}, importedItems: [] };
  }

  // Recipes indexed by PRIMARY output item.
  const producersByItem = {};
  availableRecipes.forEach((r, i) => {
    const primary = r.outputs[0].item;
    (producersByItem[primary] || (producersByItem[primary] = [])).push(i);
  });

  // Desired output rate per item.
  const desiredRate = {};
  for (const { item, rate } of desiredOutputs) {
    desiredRate[item] = (desiredRate[item] || 0) + rate;
  }

  // Per-recipe upper bound on machine count, used as the big-M coefficient.
  // Propagates demand from desired outputs down through every consuming recipe to
  // a fixed point.  Each recipe is sized as if it were the *sole* producer of its
  // item (worst case) so the bound is always >= the real machine count.  Imported
  // inputs generate no further demand.  Cycles are bounded by the iteration cap.
  function computeMaxMachines() {
    const n = availableRecipes.length;
    const maxMachines = new Array(n).fill(0);
    const maxDemand = {};
    for (const { item, rate } of desiredOutputs) maxDemand[item] = (maxDemand[item] || 0) + rate;

    const maxIter = Math.max(50, n * 2 + 10);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      availableRecipes.forEach((r, i) => {
        const out = r.outputs[0];
        const m = (maxDemand[out.item] || 0) / out.rate;
        if (m > maxMachines[i]) { maxMachines[i] = m; changed = true; }
      });
      const nd = {};
      for (const { item, rate } of desiredOutputs) nd[item] = (nd[item] || 0) + rate;
      availableRecipes.forEach((r, i) => {
        for (const inp of r.inputs) {
          if (!imp.has(inp.item)) nd[inp.item] = (nd[inp.item] || 0) + maxMachines[i] * inp.rate;
        }
      });
      for (const k of Object.keys(nd)) {
        if ((nd[k] || 0) > (maxDemand[k] || 0)) { maxDemand[k] = nd[k]; changed = true; }
      }
      if (!changed) break;
    }
    return maxMachines;
  }

  const maxMachines = computeMaxMachines();
  // Slack factor keeps the bound a safe over-estimate (so feasible plans are never
  // cut off) while staying tight enough for the integer tolerance; clamp guards
  // against degenerate 0 / runaway cyclic estimates.
  const bigM = i => Math.min(1e6, Math.max(1, maxMachines[i] * 2 + 1));

  const glpk = await getGLPK();

  const xName = i => `x${i}`;
  const bName = i => `b${i}`;

  // Objective: 1e6*b + (1 + 0.001*totalInputRate)*x  per recipe.
  const objVars = [];
  availableRecipes.forEach((r, i) => {
    const totalIn = r.inputs.reduce((s, inp) => s + inp.rate, 0);
    objVars.push({ name: xName(i), coef: 1 + 0.001 * totalIn });
    objVars.push({ name: bName(i), coef: 1e6 });
  });

  // Per-item net coefficient map for the supply>=demand rows: +out for the
  // producer, -in for every consumer (a recipe that both makes and consumes an
  // item nets out correctly).
  const itemVarCoef = {};
  function addCoef(item, name, c) {
    const m = itemVarCoef[item] || (itemVarCoef[item] = new Map());
    m.set(name, (m.get(name) || 0) + c);
  }
  availableRecipes.forEach((r, i) => {
    addCoef(r.outputs[0].item, xName(i), r.outputs[0].rate);
    for (const inp of r.inputs) addCoef(inp.item, xName(i), -inp.rate);
  });

  const subjectTo = [];
  let rowId = 0;

  // (3) supply >= demand for each non-imported item that something can produce.
  for (const item of Object.keys(itemVarCoef)) {
    if (imp.has(item)) continue;            // imported -> unlimited free supply
    if (!producersByItem[item]) continue;   // no recipe -> reported as a warning below
    const vars = [];
    for (const [name, coef] of itemVarCoef[item]) if (coef !== 0) vars.push({ name, coef });
    if (!vars.length) continue;
    subjectTo.push({
      name: `s${rowId++}`,
      vars,
      bnds: { type: glpk.GLP_LO, lb: desiredRate[item] || 0, ub: 0 },
    });
  }

  // (2) big-M linking, per recipe.
  availableRecipes.forEach((r, i) => {
    subjectTo.push({
      name: `m${i}`,
      vars: [{ name: xName(i), coef: 1 }, { name: bName(i), coef: -bigM(i) }],
      bnds: { type: glpk.GLP_UP, ub: 0, lb: 0 },
    });
  });

  // (1) at most one recipe per item (only binding where >1 recipe competes).
  for (const item of Object.keys(producersByItem)) {
    const idxs = producersByItem[item];
    if (idxs.length < 2) continue;
    subjectTo.push({
      name: `o${rowId++}`,
      vars: idxs.map(i => ({ name: bName(i), coef: 1 })),
      bnds: { type: glpk.GLP_UP, ub: 1, lb: 0 },
    });
  }

  const bounds = availableRecipes.map((r, i) => ({ name: xName(i), type: glpk.GLP_LO, lb: 0, ub: 0 }));
  const binaries = availableRecipes.map((r, i) => bName(i));

  const lp = {
    name: 'factory',
    objective: { direction: glpk.GLP_MIN, name: 'cost', vars: objVars },
    subjectTo,
    bounds,
    binaries,
  };

  let sol;
  try {
    const res = await glpk.solve(lp, glpk.GLP_MSG_OFF);
    sol = res && res.result;
  } catch (e) {
    sol = null;
  }

  if (!sol || (sol.status !== glpk.GLP_OPT && sol.status !== glpk.GLP_FEAS)) {
    warnings.push('Could not find a feasible factory plan. Check that every required item has a recipe or is imported, and break any circular dependencies.');
    return { floors: [], warnings, rates: {}, importedItems: [] };
  }

  // ── reconstruct the plan from the solution ──────────────────────────────────
  // chosenRecipes[item] = the single recipe whose primary output is `item`, when
  // it runs (x > 0).  finalRates[item] = items/min produced (== demand at the LP
  // optimum, since producing more would only add machines).
  const chosenRecipes = {};
  const finalRates = {};
  availableRecipes.forEach((r, i) => {
    const x = sol.vars[xName(i)] || 0;
    if (x <= EPS) return;
    const item = r.outputs[0].item;
    chosenRecipes[item] = r;
    finalRates[item] = (finalRates[item] || 0) + x * r.outputs[0].rate;
  });

  // Warn about items that are needed (desired, or consumed by a chosen recipe) but
  // have no recipe and are not imported.
  const needed = new Set(Object.keys(desiredRate));
  for (const item of Object.keys(chosenRecipes)) {
    for (const inp of chosenRecipes[item].inputs) needed.add(inp.item);
  }
  for (const item of needed) {
    if (!imp.has(item) && !chosenRecipes[item]) {
      warn(
        `Your factory needs "${item}" but no available recipe produces it. ` +
        `Add it as an imported item, or enable/choose a recipe that makes it.`,
        item
      );
    }
  }

  const produced = Object.keys(chosenRecipes);
  const producedSet = new Set(produced);

  // Topological sort (Kahn's algorithm).
  // Self-referential inputs (net-consumption recipes like Encased Uranium Cell
  // that consume AND emit Sulfuric Acid) are skipped to prevent spurious self-loops.
  const adj = {}, inDeg = {};
  for (const i of produced) { adj[i] = []; inDeg[i] = 0; }
  for (const item of produced) {
    for (const inp of chosenRecipes[item].inputs) {
      if (producedSet.has(inp.item) && inp.item !== item) {
        adj[inp.item].push(item);
        inDeg[item]++;
      }
    }
  }

  const queue = produced.filter(i => inDeg[i] === 0).sort();
  const sorted = [];
  while (queue.length) {
    queue.sort();
    const item = queue.shift();
    sorted.push(item);
    for (const dep of adj[item]) { if (--inDeg[dep] === 0) queue.push(dep); }
  }

  if (sorted.length < produced.length) {
    const cycled = produced.filter(i => !sorted.includes(i));
    const inCycle = new Set(cycled);

    // DFS to find the minimal loop path within the cycled subgraph.
    // Returns e.g. ['Crude Oil', 'Packaged Oil', 'Crude Oil'] — the repeated
    // first element is what needs to be imported to break the cycle.
    function findCyclePath() {
      const done = new Set(), stack = [], onStack = new Set();
      let found = null;
      function dfs(node) {
        if (found || done.has(node)) return;
        if (onStack.has(node)) { found = [...stack.slice(stack.indexOf(node)), node]; return; }
        onStack.add(node); stack.push(node);
        for (const inp of (chosenRecipes[node]?.inputs ?? [])) {
          if (inCycle.has(inp.item)) { dfs(inp.item); if (found) break; }
        }
        stack.pop(); onStack.delete(node); done.add(node);
      }
      for (const node of cycled) { dfs(node); if (found) break; }
      return found;
    }

    const path = findCyclePath();
    if (path) {
      const root = path[0];
      warnings.push(
        `Circular dependency: ${path.join(' → ')}. ` +
        `Add "${root}" to your imported items to fix this.`
      );
    } else {
      warnings.push(`Circular dependency detected among: ${cycled.join(', ')} — check recipe selections.`);
    }
    for (const i of cycled) sorted.push(i);
  }

  // ALAP re-ordering: place each item as late as possible (just before its
  // earliest consumer) to minimise conveyor-bus travel distance.
  // Reverse Kahn's: start from sinks (items nothing internally depends on),
  // build a reversed topo list, then flip it.  Items in cycles never reach
  // outDeg 0 and are appended at the end unchanged.
  {
    const outDeg = {};
    for (const i of sorted) outDeg[i] = 0;
    for (const item of sorted) {
      for (const inp of chosenRecipes[item].inputs) {
        if (inp.item !== item && Object.prototype.hasOwnProperty.call(outDeg, inp.item)) {
          outDeg[inp.item]++;
        }
      }
    }
    const q = sorted.filter(i => outDeg[i] === 0).sort();
    const rev = [];
    while (q.length) {
      q.sort();
      const item = q.shift();
      rev.push(item);
      for (const inp of chosenRecipes[item].inputs) {
        if (inp.item !== item && Object.prototype.hasOwnProperty.call(outDeg, inp.item)) {
          if (--outDeg[inp.item] === 0) q.push(inp.item);
        }
      }
    }
    rev.reverse();
    const placed = new Set(rev);
    for (const item of sorted) { if (!placed.has(item)) rev.push(item); }
    sorted.length = 0;
    for (const item of rev) sorted.push(item);
  }

  const desiredSet = new Set(desiredOutputs.map(d => d.item));
  const beltFor = beltSettings
    ? rate => calcBelts(rate, beltSettings.beltMark, beltSettings.beltUniform)
    : () => null;

  const floors = sorted.map((item, idx) => {
    const r = chosenRecipes[item];
    const oe = r.outputs.find(o => o.item === item);
    const itemRate = finalRates[item];
    const mc = itemRate / oe.rate;
    return {
      num: idx + 1,
      product: item,
      recipe: r,
      machineCount: mc,
      outputRate: itemRate,
      outputBelts: beltFor(itemRate),
      isDesired: desiredSet.has(item),
      inputs: r.inputs.map(i => ({ item: i.item, rate: i.rate * mc, imported: imp.has(i.item), belts: beltFor(i.rate * mc) })),
      byproducts: r.outputs.filter(o => o.item !== item).map(o => ({ item: o.item, rate: o.rate * mc })),
    };
  });

  const importedTotals = {};
  for (const f of floors) {
    for (const inp of f.inputs) {
      if (inp.imported) importedTotals[inp.item] = (importedTotals[inp.item] || 0) + inp.rate;
    }
  }
  const importedItems = Object.entries(importedTotals)
    .filter(([, r]) => r > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([item, rate]) => ({ item, rate, belts: beltFor(rate) }));

  return { floors, warnings, rates: finalRates, importedItems };
}

function fmtRate(n) {
  if (n === Math.round(n)) return n.toString();
  return n.toFixed(4).replace(/\.?0+$/, '');
}

if (typeof module !== 'undefined') {
  module.exports = { planFactory, calcBelts, BELT_MARKS };
}

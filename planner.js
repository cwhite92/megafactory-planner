'use strict';

// Plans a megafactory layout.
//
// params:
//   availableRecipes - recipe objects already filtered to the user's selection;
//                      when multiple recipes produce the same item the planner
//                      automatically picks the best one (see chooseBestRecipe)
//   imports          - string[] of items fed in from outside (no production floor)
//   outputs          - {item, rate}[] of desired factory products
//
// Recipe selection heuristic (chooseBestRecipe):
//   Primary:   prefer the recipe whose inputs are most "already in the plan"
//              (imported or already needed by something else) — minimises new floors
//   Tiebreak:  higher primary output rate → fewer machines for the same throughput
//
// Two-pass optimisation: the planner runs the DFS twice.  Pass 1 discovers every
// item the factory will produce.  Pass 2 re-runs with that full item set treated as
// "already available", so recipe choices are not biased by DFS traversal order —
// items produced as intermediates get the same treatment as declared outputs.
//
// Cycle-safety: BY_OUTPUT is keyed by PRIMARY output only — byproducts are never
// indexed, preventing false cycles (e.g. Aluminum Scrap emits Water as byproduct;
// indexing Water here would route Water through Aluminum Scrap → cycle).
//
// returns { floors, warnings, rates }
//   floors  - ordered bottom-to-top (floor 1 first):
//             { num, product, recipe, machineCount, outputRate, isDesired, inputs, byproducts }
//   warnings - string[]
//   rates    - { [item]: number } items/min needed across the whole plan
function planFactory({
  availableRecipes,
  imports: importList = [],
  outputs: desiredOutputs = [],
}) {
  const imp = new Set(importList);
  const warnings = [];
  const warnedItems = new Set();

  function warn(msg, key) {
    if (warnedItems.has(key)) return;
    warnedItems.add(key);
    warnings.push(msg);
  }

  if (!desiredOutputs.length) {
    return { floors: [], warnings: ['No desired outputs configured.'], rates: {} };
  }

  // Index available recipes by PRIMARY output only.
  const BY_OUTPUT = {};
  for (const r of availableRecipes) {
    const primary = r.outputs[0].item;
    if (!BY_OUTPUT[primary]) BY_OUTPUT[primary] = [];
    BY_OUTPUT[primary].push(r);
  }

  // Runs the recipe-selection DFS and returns { rates, chosenRecipes }.
  // preKnown: items discovered in a prior pass — treated as already in the
  // factory (0 new floors) so recipe choices have full context from the start.
  // emitWarnings: only true on the final pass to avoid duplicate messages.
  function runDFS(preKnown, emitWarnings) {
    const rates = {};
    const chosenRecipes = {};

    function transitiveNew(it, seen) {
      if (imp.has(it) || it in rates || preKnown.has(it) || seen.has(it)) return 0;
      seen.add(it);
      if (chosenRecipes[it]) return 1 + chosenRecipes[it].inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
      const cands = BY_OUTPUT[it];
      if (!cands || !cands.length) return 1;
      let bestR = cands[0], bestDirect = Infinity;
      for (const r of cands) {
        const d = r.inputs.filter(i => !imp.has(i.item) && !(i.item in rates) && !preKnown.has(i.item) && !seen.has(i.item)).length;
        if (d < bestDirect) { bestDirect = d; bestR = r; }
      }
      return 1 + bestR.inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
    }

    function chooseBestRecipe(item) {
      const candidates = BY_OUTPUT[item];
      if (!candidates || !candidates.length) return null;
      if (candidates.length === 1) return candidates[0];

      let best = null, bestScore = -Infinity;
      for (const r of candidates) {
        const oe = r.outputs.find(o => o.item === item);
        if (!oe) continue;
        const seen = new Set([item]);
        const newFloors = r.inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
        const score = -newFloors * 1e6 + oe.rate;
        if (score > bestScore) { bestScore = score; best = r; }
      }
      return best;
    }

    for (const { item, rate } of desiredOutputs) {
      rates[item] = (rates[item] || 0) + rate;
    }

    const stack = desiredOutputs.map(d => d.item).filter(i => !imp.has(i));
    const visited = new Set();

    while (stack.length) {
      const item = stack.pop();
      if (visited.has(item) || imp.has(item)) continue;
      visited.add(item);
      const r = chooseBestRecipe(item);
      if (!r) {
        if (emitWarnings) warn(`Your factory needs "${item}". Add it as an import, add a recipe for it, or choose an alt recipe to eliminate the need for it.`, item);
        continue;
      }
      chosenRecipes[item] = r;
      const oe = r.outputs.find(o => o.item === item);
      if (!oe) continue;
      const mc = rates[item] / oe.rate;
      for (const inp of r.inputs) {
        if (!imp.has(inp.item)) {
          rates[inp.item] = (rates[inp.item] || 0) + inp.rate * mc;
          if (!visited.has(inp.item)) stack.push(inp.item);
        }
      }
    }

    return { rates, chosenRecipes };
  }

  // Discover every item reachable from desired outputs via *any* available recipe
  // (not just the greedy-chosen one).  Used to pre-seed preKnown so that recipe
  // choices don't depend on DFS traversal order — items producible via any
  // alternative are treated as already available from the start.
  function discoverAllReachable() {
    const reachable = new Set();
    const stack = desiredOutputs.map(d => d.item).filter(i => !imp.has(i));
    while (stack.length) {
      const item = stack.pop();
      if (reachable.has(item) || imp.has(item)) continue;
      reachable.add(item);
      for (const r of (BY_OUTPUT[item] || [])) {
        for (const inp of r.inputs) {
          if (!reachable.has(inp.item) && !imp.has(inp.item)) stack.push(inp.item);
        }
      }
    }
    return reachable;
  }

  const { rates, chosenRecipes } = runDFS(discoverAllReachable(), true);

  // Catch any items in rates that were never resolved (should be rare).
  for (const item of Object.keys(rates)) {
    if (!imp.has(item) && !chosenRecipes[item]) {
      warn(
        `"${item}" needs ${fmtRate(rates[item])}/min but has no available recipe — ` +
        `enable a recipe for it or mark it as imported.`,
        item
      );
    }
  }

  const produced = Object.keys(rates).filter(i => !imp.has(i) && chosenRecipes[i]);
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

  // Recompute rates top-down in reverse-topo order so that desired-output items
  // processed early by the DFS (before all consumers were known) don't produce
  // under-counted ingredient rates.  Each item's finalRates entry = desired rate
  // (if any) + sum of demand from every floor above it, computed consistently.
  const finalRates = {};
  for (const { item, rate } of desiredOutputs) {
    finalRates[item] = (finalRates[item] || 0) + rate;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const item = sorted[i];
    if (!(item in finalRates)) continue;
    const r = chosenRecipes[item];
    const oe = r.outputs.find(o => o.item === item);
    const mc = finalRates[item] / oe.rate;
    for (const inp of r.inputs) {
      if (!imp.has(inp.item) && chosenRecipes[inp.item]) {
        finalRates[inp.item] = (finalRates[inp.item] || 0) + inp.rate * mc;
      }
    }
  }

  const desiredSet = new Set(desiredOutputs.map(d => d.item));
  const floors = sorted.map((item, idx) => {
    const r = chosenRecipes[item];
    const oe = r.outputs.find(o => o.item === item);
    const itemRate = finalRates[item] ?? rates[item];
    const mc = itemRate / oe.rate;
    return {
      num: idx + 1,
      product: item,
      recipe: r,
      machineCount: mc,
      outputRate: itemRate,
      isDesired: desiredSet.has(item),
      inputs: r.inputs.map(i => ({ item: i.item, rate: i.rate * mc, imported: imp.has(i.item) })),
      byproducts: r.outputs.filter(o => o.item !== item).map(o => ({ item: o.item, rate: o.rate * mc })),
    };
  });

  return { floors, warnings, rates: finalRates };
}

function fmtRate(n) {
  if (n === Math.round(n)) return n.toString();
  return n.toFixed(4).replace(/\.?0+$/, '');
}

if (typeof module !== 'undefined') {
  module.exports = { planFactory };
}

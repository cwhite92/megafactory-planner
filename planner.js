'use strict';

function parseRecipes(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const isAlt = line.startsWith('[Alt]');
    const rest = isAlt ? line.slice(5).trim() : line;
    const ci = rest.indexOf(':');
    if (ci === -1) continue;
    const lhs = rest.slice(0, ci).trim();
    const rhs = rest.slice(ci + 1).trim();
    const mm = lhs.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!mm) continue;
    const recipeName = mm[1].trim();
    const machine = mm[2].trim();
    const ai = rhs.indexOf('->');
    if (ai === -1) continue;
    const inpStr = rhs.slice(0, ai).trim();
    const outStr = rhs.slice(ai + 2).trim();
    function pi(s) {
      if (s === '(none)') return [];
      return s.split('+').map(p => {
        const m = p.trim().match(/^(.+?)\s+([\d.]+)\/min$/);
        return m ? { item: m[1].trim(), rate: parseFloat(m[2]) } : null;
      }).filter(Boolean);
    }
    const inputs = pi(inpStr);
    const outputs = pi(outStr);
    if (outputs.length) out.push({ name: recipeName, machine, isAlt, inputs, outputs });
  }
  return out;
}

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

  // rates is populated during the DFS below; chooseBestRecipe closes over it so
  // each decision reflects which inputs are already committed to the plan.
  const rates = {};

  function chooseBestRecipe(item) {
    const candidates = BY_OUTPUT[item];
    if (!candidates || !candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    // Recursively estimates total new production floors a recipe choice would require.
    // `seen` is shared across siblings of the same candidate to avoid double-counting
    // items used by multiple inputs of the same recipe.
    function transitiveNew(it, seen) {
      if (imp.has(it) || it in rates || seen.has(it)) return 0;
      seen.add(it);
      if (chosenRecipes[it]) return 1 + chosenRecipes[it].inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
      const cands = BY_OUTPUT[it];
      if (!cands || !cands.length) return 1;
      // Greedy sub-choice: pick the candidate with the fewest direct new inputs for estimation.
      let bestR = cands[0], bestDirect = Infinity;
      for (const r of cands) {
        const d = r.inputs.filter(i => !imp.has(i.item) && !(i.item in rates) && !seen.has(i.item)).length;
        if (d < bestDirect) { bestDirect = d; bestR = r; }
      }
      return 1 + bestR.inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
    }

    let best = null, bestScore = -Infinity;
    for (const r of candidates) {
      const oe = r.outputs.find(o => o.item === item);
      if (!oe) continue;
      // Count total transitive new floors — not just direct inputs.
      const seen = new Set([item]);
      const newFloors = r.inputs.reduce((s, i) => s + transitiveNew(i.item, seen), 0);
      // Primary: fewer new floors. Tiebreak: higher output rate = fewer machines.
      const score = -newFloors * 1e6 + oe.rate;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  // Memoised recipe choices — locked in during DFS, reused by topo-sort and floor builder.
  const chosenRecipes = {};

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
      warn(`"${item}" has no available recipe and is not marked as imported.`, item);
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
    warnings.push(`Circular dependency detected among: ${cycled.join(', ')} — check recipe selections.`);
    for (const i of cycled) sorted.push(i);
  }

  const desiredSet = new Set(desiredOutputs.map(d => d.item));
  const floors = sorted.map((item, idx) => {
    const r = chosenRecipes[item];
    const oe = r.outputs.find(o => o.item === item);
    const mc = rates[item] / oe.rate;
    return {
      num: idx + 1,
      product: item,
      recipe: r,
      machineCount: mc,
      outputRate: rates[item],
      isDesired: desiredSet.has(item),
      inputs: r.inputs.map(i => ({ item: i.item, rate: i.rate * mc, imported: imp.has(i.item) })),
      byproducts: r.outputs.filter(o => o.item !== item).map(o => ({ item: o.item, rate: o.rate * mc })),
    };
  });

  return { floors, warnings, rates };
}

function fmtRate(n) {
  if (n === Math.round(n)) return n.toString();
  return n.toFixed(4).replace(/\.?0+$/, '');
}

if (typeof module !== 'undefined') {
  module.exports = { parseRecipes, planFactory };
}

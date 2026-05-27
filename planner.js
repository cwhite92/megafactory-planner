'use strict';

// Parses the recipes.txt format into recipe objects.
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
//   recipes      - array from parseRecipes()
//   imports      - string[] of items fed in from outside (no production floor)
//   outputs      - {item, rate}[] of desired factory products
//   machines     - string[] of enabled machine types (recipes for other types excluded)
//   altRecipes   - string[] of alt recipe names that are opt-in enabled
//   choices      - {[item]: recipeName} optional per-item recipe override
//
// returns { floors, warnings, rates }
//   floors  - ordered bottom-to-top (floor 1 first), each:
//             { num, product, recipe, machineCount, outputRate, isDesired, inputs, byproducts }
//   warnings - string[]
//   rates    - {[item]: number} total items/min needed for each item in the plan
//
// Cycle-safety: BY_OUTPUT is indexed by PRIMARY output only. Byproducts are
// never indexed, which eliminates false cycles such as Aluminum Scrap emitting
// Water as a byproduct — without this constraint, Water would resolve to the
// Aluminum Scrap recipe, producing a Water→Alumina Solution→Water cycle.
function planFactory({
  recipes,
  imports: importList = [],
  outputs: desiredOutputs = [],
  machines: enabledMachines = [],
  altRecipes: enabledAltRecipes = [],
  choices = {},
}) {
  const imp = new Set(importList);
  const machineSet = new Set(enabledMachines);
  const altSet = new Set(enabledAltRecipes);
  const warnings = [];

  if (!desiredOutputs.length) {
    return { floors: [], warnings: ['No desired outputs configured.'], rates: {} };
  }

  // Build recipe index keyed by PRIMARY (first-listed) output only.
  const BY_OUTPUT = {};
  for (const r of recipes) {
    if (!machineSet.has(r.machine)) continue;
    if (r.isAlt && !altSet.has(r.name)) continue;
    const primary = r.outputs[0].item;
    if (!BY_OUTPUT[primary]) BY_OUTPUT[primary] = [];
    BY_OUTPUT[primary].push(r);
  }

  function chosenRecipe(item) {
    const rs = BY_OUTPUT[item];
    if (!rs || !rs.length) return null;
    const override = choices[item];
    if (override) return rs.find(r => r.name === override) || rs.find(r => !r.isAlt) || rs[0];
    return rs.find(r => !r.isAlt) || rs[0];
  }

  // DFS to accumulate required production rates for every item in the chain.
  const rates = {};
  for (const { item, rate } of desiredOutputs) {
    rates[item] = (rates[item] || 0) + rate;
  }

  const stack = desiredOutputs.map(d => d.item).filter(i => !imp.has(i));
  const visited = new Set();

  while (stack.length) {
    const item = stack.pop();
    if (visited.has(item) || imp.has(item)) continue;
    visited.add(item);
    const r = chosenRecipe(item);
    if (!r) {
      warnings.push(`"${item}" has no recipe and is not marked as imported.`);
      continue;
    }
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

  // Warn about items that are needed but have no recipe and aren't imported.
  for (const item of Object.keys(rates)) {
    if (!imp.has(item) && !chosenRecipe(item)) {
      warnings.push(
        `"${item}" needs ${fmtRate(rates[item])}/min but has no recipe — mark it as imported if it's a raw resource.`
      );
    }
  }

  // Items that will receive a production floor.
  const produced = Object.keys(rates).filter(i => !imp.has(i) && chosenRecipe(i));
  const producedSet = new Set(produced);

  // Topological sort (Kahn's algorithm).
  // Edge: inp.item → item means "item depends on inp.item" (inp must be on a lower floor).
  // Self-referential inputs (net-consumption recipes like Encased Uranium Cell consuming
  // Sulfuric Acid while also emitting it) are skipped to avoid spurious self-loops.
  const adj = {};
  const inDeg = {};
  for (const i of produced) { adj[i] = []; inDeg[i] = 0; }

  for (const item of produced) {
    for (const inp of chosenRecipe(item).inputs) {
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
    for (const dep of adj[item]) {
      if (--inDeg[dep] === 0) queue.push(dep);
    }
  }

  if (sorted.length < produced.length) {
    const cycled = produced.filter(i => !sorted.includes(i));
    warnings.push(
      `Circular dependency detected among: ${cycled.join(', ')} — check recipe selections.`
    );
    for (const i of cycled) sorted.push(i);
  }

  const desiredSet = new Set(desiredOutputs.map(d => d.item));
  const floors = sorted.map((item, idx) => {
    const r = chosenRecipe(item);
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

// Node.js compatibility for tests
if (typeof module !== 'undefined') {
  module.exports = { parseRecipes, planFactory };
}

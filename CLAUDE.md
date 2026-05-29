# Mega Planner

## Hard requirements

- **`planner.js` contains all factory planning logic.** `index.html` is presentation only — no planning calculations belong there.
  - Belt calculations, machine filtering, rate computations, recipe selection, floor ordering: all in `planner.js`.
  - `index.html` reads from the data `planFactory` returns and renders it. It does not derive or transform planning data itself.

- **All factory logic in `planner.js` must be covered by extensive tests** (`planner.test.js`, run with `node planner.test.js`).
  - When adding or changing factory logic, add or update tests to cover it.
  - When refactoring `planner.js` without changing its output, use the test suite to verify correctness — tests must stay green throughout.

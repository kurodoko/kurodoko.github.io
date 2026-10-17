import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Solver, BASIC, CONNECT, TRIAL, BLACK, WHITE, UNKNOWN } from '../src/solver.js';
import { isValidSolution, visibleCount, components, neighbourTable } from '../src/grid.js';
import { Rng } from '../src/rng.js';

/** Independent brute force: all valid solutions (up to limit) of a small puzzle. */
function bruteForce(w, h, clues, limit = 3) {
  const n = w * h;
  const black = new Uint8Array(n);
  const found = [];
  const rec = (i) => {
    if (found.length >= limit) return;
    if (i === n) {
      if (isValidSolution(w, h, clues, black)) found.push(Array.from(black));
      return;
    }
    rec(i + 1);
    const r = Math.floor(i / w);
    const c = i % w;
    if (!clues[i] && !(c > 0 && black[i - 1]) && !(r > 0 && black[i - w])) {
      black[i] = 1;
      rec(i + 1);
      black[i] = 0;
    }
  };
  rec(0);
  return found;
}

/** Random valid shading by rejection, for tests. */
function randomShading(w, h, rng) {
  const n = w * h;
  const nb = neighbourTable(w, h);
  const black = new Uint8Array(n);
  for (const i of rng.shuffle(Array.from({ length: n }, (_, i) => i))) {
    if (!rng.chance(0.4)) continue;
    let ok = true;
    for (let d = 0; d < 4; d++) if (nb[4 * i + d] >= 0 && black[nb[4 * i + d]]) ok = false;
    if (!ok) continue;
    black[i] = 1;
    if (components(w, h, (j) => !black[j]).sizes.length !== 1) black[i] = 0;
  }
  return black;
}

function cluesFor(w, h, black, rng, density) {
  return Array.from({ length: w * h }, (_, i) =>
    !black[i] && rng.chance(density) ? visibleCount(w, h, i, (j) => black[j]) : 0);
}

test('solver agrees with brute force on small random puzzles', () => {
  const rng = new Rng('solver-vs-brute');
  let solvedCount = 0;
  for (let t = 0; t < 300; t++) {
    const w = 3 + rng.int(3);
    const h = 3 + rng.int(3);
    const black = randomShading(w, h, rng);
    const clues = cluesFor(w, h, black, rng, 0.2 + 0.6 * rng.float());
    const truth = bruteForce(w, h, clues);
    assert.ok(truth.length >= 1, 'the generating shading is always a solution');
    const solver = new Solver(w, h);
    for (const level of [BASIC, CONNECT, TRIAL]) {
      solver.load(clues);
      if (solver.solve(level)) {
        solvedCount++;
        assert.equal(truth.length, 1, `solver claimed a unique solution at level ${level}`);
        assert.deepEqual(solver.grid().map((v) => (v === BLACK ? 1 : 0)), truth[0]);
      } else {
        assert.ok(!solver.contradiction);
        // Whatever it did deduce must hold in every solution.
        solver.grid().forEach((v, i) => {
          if (v !== UNKNOWN) for (const sol of truth) assert.equal(sol[i], v === BLACK ? 1 : 0);
        });
      }
    }
    solver.load(clues);
    assert.equal(solver.countSolutions(3), Math.min(truth.length, 3), 'countSolutions matches brute force');
  }
  assert.ok(solvedCount > 100, 'test covers enough solvable cases');
});

test('cut detection matches flood fill', () => {
  const rng = new Rng('cuts');
  for (let t = 0; t < 200; t++) {
    const w = 3 + rng.int(8);
    const h = 3 + rng.int(8);
    const black = randomShading(w, h, rng);
    const solver = new Solver(w, h).load(new Array(w * h).fill(0));
    for (let i = 0; i < w * h; i++) if (black[i]) assert.ok(solver.set(i, BLACK));
    const parts = (extra) => components(w, h, (j) => !black[j] && j !== extra).sizes.length;
    for (let i = 0; i < w * h; i++) {
      if (black[i]) continue;
      assert.equal(solver.isCut(i), parts(i) > 1, `cell ${i} in ${w}x${h}`);
    }
  }
});

test('rollback restores the exact state', () => {
  const rng = new Rng('rollback');
  const w = 8;
  const h = 7;
  const black = randomShading(w, h, rng);
  const clues = cluesFor(w, h, black, rng, 0.5);
  const solver = new Solver(w, h).load(clues);
  const m = solver.mark();
  const before = { st: solver.grid(), unknown: solver.unknown, parent: Array.from(solver.dsuParent) };
  solver.solve(TRIAL);
  solver.rollback(m);
  assert.deepEqual(solver.grid(), before.st);
  assert.equal(solver.unknown, before.unknown);
  assert.deepEqual(Array.from(solver.dsuParent), before.parent);
});

test('fully clued grids are always solved at the basic level', () => {
  const rng = new Rng('full');
  for (let t = 0; t < 50; t++) {
    const w = 4 + rng.int(10);
    const h = 4 + rng.int(10);
    const black = randomShading(w, h, rng);
    const clues = cluesFor(w, h, black, rng, 1);
    const solver = new Solver(w, h).load(clues);
    assert.ok(solver.solve(BASIC));
    assert.deepEqual(solver.grid().map((v) => (v === BLACK ? 1 : 0)), Array.from(black));
  }
});

test('white is the value, not just non-black', () => {
  assert.equal(WHITE, 0);
  assert.equal(BLACK, 1);
});

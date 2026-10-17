import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, checkParams } from '../src/generator.js';
import { Solver } from '../src/solver.js';
import { isValidSolution, visibleCount } from '../src/grid.js';
import { Rng, hashParts } from '../src/rng.js';

function assertWellFormed(p) {
  const { w, h, clues, solution } = p;
  assert.equal(clues.length, w * h);
  assert.ok(isValidSolution(w, h, clues, solution), 'solution satisfies every rule');
  clues.forEach((v, i) => {
    if (v) assert.equal(v, visibleCount(w, h, i, (j) => solution[j]), 'clue matches solution');
  });
  const solver = new Solver(w, h).load(clues);
  assert.equal(solver.countSolutions(2), 1, `${w}x${h} seed ${p.seed} ${p.difficulty} has one solution`);
}

test('rng is stable across runs and engines', () => {
  assert.deepEqual(hashParts('kurodoko', 1), hashParts('kurodoko', 1));
  const r = new Rng('fixed');
  const seq = Array.from({ length: 5 }, () => r.next());
  assert.deepEqual(seq, [136600265, 3078282680, 2372175199, 3745547469, 2498792697]);
});

test('same parameters give the same puzzle', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const a = generate({ w: 12, h: 9, seed: 77, difficulty });
    const b = generate({ w: 12, h: 9, seed: '77', difficulty });
    assert.deepEqual(a, b);
  }
  const c = generate({ w: 12, h: 9, seed: 78, difficulty: 'easy' });
  const d = generate({ w: 12, h: 9, seed: 77, difficulty: 'easy' });
  assert.notDeepEqual(c.clues, d.clues);
});

test('small puzzles are well formed and unique', () => {
  for (const [w, h] of [[4, 4], [5, 7], [7, 5], [8, 8], [10, 10], [12, 6]]) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      for (let seed = 1; seed <= 4; seed++) assertWellFormed(generate({ w, h, seed, difficulty }));
    }
  }
});

test('larger puzzles are unique', () => {
  for (const [w, h, seed] of [[20, 20, 1], [25, 15, 2], [31, 31, 3]]) {
    for (const difficulty of ['easy', 'medium', 'hard']) assertWellFormed(generate({ w, h, seed, difficulty }));
  }
});

test('the largest size generates', () => {
  for (const difficulty of ['easy', 'hard']) assertWellFormed(generate({ w: 60, h: 60, seed: 9, difficulty }));
});

test('easier puzzles keep more numbers', () => {
  const total = { easy: 0, medium: 0, hard: 0 };
  for (let seed = 1; seed <= 6; seed++) {
    for (const difficulty of Object.keys(total)) {
      total[difficulty] += generate({ w: 15, h: 15, seed, difficulty }).clues.filter(Boolean).length;
    }
  }
  assert.ok(total.easy > total.medium && total.medium > total.hard, JSON.stringify(total));
});

test('parameters are validated', () => {
  assert.throws(() => checkParams({ w: 3, h: 10, seed: 1, difficulty: 'easy' }));
  assert.throws(() => checkParams({ w: 61, h: 10, seed: 1, difficulty: 'easy' }));
  assert.throws(() => checkParams({ w: 10, h: 10, seed: 'x', difficulty: 'easy' }));
  assert.throws(() => checkParams({ w: 10, h: 10, seed: 1, difficulty: 'expert' }));
  assert.doesNotThrow(() => checkParams({ w: 60, h: 4, seed: -5, difficulty: 'hard' }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, FILLED, DOT, EMPTY } from '../src/game.js';
import { generate } from '../src/generator.js';
import { Solver } from '../src/solver.js';
import { findMistakes, findHint, rewindToCorrect } from '../src/hint.js';
import { Rng } from '../src/rng.js';

test('mistakes are wrong fills and wrong player dots only', () => {
  const p = generate({ w: 8, h: 8, seed: 2, difficulty: 'easy' });
  const g = new Game(p);
  assert.deepEqual(findMistakes(g, p.solution), []);
  const white = p.solution.findIndex((b, i) => !b && !p.clues[i] && g.cells[i] === EMPTY);
  g.click(white, true); // fill an unshaded cell
  const black = p.solution.findIndex((b, i) => b && g.cells[i] === EMPTY);
  g.click(black); // own dot on a shaded cell
  assert.deepEqual(findMistakes(g, p.solution).sort((a, b) => a - b), [white, black].sort((a, b) => a - b));
});

test('rewinding undoes back to the last position without mistakes', () => {
  const p = generate({ w: 8, h: 8, seed: 2, difficulty: 'easy' });
  const g = new Game(p);
  const blacks = p.solution.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  g.click(blacks[0], true); // correct
  const good = Array.from(g.cells);
  const white = p.solution.findIndex((b, i) => !b && !p.clues[i] && g.cells[i] === EMPTY);
  g.click(white, true); // wrong
  g.click(blacks[1], true); // correct, after the mistake
  assert.deepEqual(rewindToCorrect(g, p.solution), { undone: 2, erased: 0 });
  assert.deepEqual(Array.from(g.cells), good);
  assert.equal(g.future.length, 2, 'redo can bring the moves back');
  // Without history (e.g. reloaded), the wrong marks are erased instead.
  const h = new Game(p, { cells: Array.from(g.cells, String).join('') });
  h.click(white, true);
  h.history.length = 0;
  assert.deepEqual(rewindToCorrect(h, p.solution), { undone: 0, erased: 1 });
  assert.deepEqual(findMistakes(h, p.solution), []);
});

test('hints point at a number that really decides something, or a real step', () => {
  const rng = new Rng('hint-test');
  for (const [w, h, difficulty] of [[8, 8, 'easy'], [10, 10, 'medium'], [10, 10, 'hard'], [15, 12, 'hard']]) {
    for (let seed = 1; seed <= 3; seed++) {
      const p = generate({ w, h, seed, difficulty });
      const g = new Game(p);
      // Play correct moves at random, asking for a hint now and then.
      const blacks = rng.shuffle(p.solution.map((b, i) => (b ? i : -1)).filter((i) => i >= 0));
      for (let k = 0; k <= blacks.length; k++) {
        if (k % 3 === 0 && !g.analyze().solved) {
          const hint = findHint(g);
          assert.ok(hint, 'unsolved boards always get a hint');
          assert.ok(['number', 'area'].includes(hint.kind));
          if (hint.kind === 'number') assert.ok(p.clues[hint.cell], 'number hints point at a number');
        }
        if (k < blacks.length) g.click(blacks[k], true);
      }
      assert.ok(g.analyze().solved);
      assert.equal(findHint(g), null, 'nothing left to hint once solved');
    }
  }
});

test('a number hint is one whose count alone decides an unmarked cell', () => {
  const p = generate({ w: 10, h: 10, seed: 4, difficulty: 'medium' });
  const g = new Game(p);
  const hint = findHint(g);
  assert.equal(hint.kind, 'number');
  // Re-check independently: that number alone, on the current marks, decides a cell.
  const s = new Solver(10, 10).load(p.clues);
  s.clearQueues();
  for (let i = 0; i < 100; i++) if (g.cells[i] && !p.clues[i]) s.set(i, g.cells[i] === FILLED ? 1 : 0);
  s.clearQueues();
  const before = s.unknown;
  assert.ok(s.evalClue(hint.cell));
  assert.ok(s.unknown < before);
});

test('hints prefer places near the last move', () => {
  const p = generate({ w: 20, h: 20, seed: 6, difficulty: 'easy' });
  const g = new Game(p);
  const far = p.solution.findLastIndex((b) => b);
  g.click(far, true);
  const hint = findHint(g);
  const d = (a, b) => Math.abs(Math.floor(a / 20) - Math.floor(b / 20)) + Math.abs((a % 20) - (b % 20));
  assert.ok(d(hint.cell, far) <= 10, `hint ${hint.cell} is near the last move ${far}`);
});

test('hint count is saved with progress', () => {
  const p = generate({ w: 8, h: 8, seed: 2, difficulty: 'easy' });
  const g = new Game(p);
  g.hints = 3;
  assert.equal(new Game(p, JSON.parse(JSON.stringify(g.serialize()))).hints, 3);
});

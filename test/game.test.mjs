import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, EMPTY, DOT, AUTO, FILLED, CLUE_OPEN, CLUE_DONE, CLUE_ERROR, nextState } from '../src/game.js';
import { generate } from '../src/generator.js';

// 4×4 board, cells indexed r*4+c. One clue at (0,0) = 4.
//   4 . . .
//   . . . .
//   . . . .
//   . . . .
const board = () => new Game({ w: 4, h: 4, clues: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
const at = (r, c) => r * 4 + c;

test('click cycles empty → dot → filled → empty, right click reverses', () => {
  assert.equal(nextState(EMPTY), DOT);
  assert.equal(nextState(DOT), FILLED);
  assert.equal(nextState(AUTO), FILLED);
  assert.equal(nextState(FILLED), EMPTY);
  assert.equal(nextState(EMPTY, true), FILLED);
  assert.equal(nextState(FILLED, true), DOT);
  assert.equal(nextState(DOT, true), EMPTY);
  assert.equal(nextState(AUTO, true), EMPTY);
  const g = board();
  const i = at(1, 1);
  g.click(i);
  assert.equal(g.cells[i], DOT);
  g.click(i);
  assert.equal(g.cells[i], FILLED);
  g.click(i);
  assert.equal(g.cells[i], EMPTY);
});

test('clue cells cannot be marked', () => {
  const g = board();
  g.click(0);
  assert.equal(g.cells[0], EMPTY);
  assert.equal(g.history.length, 0);
});

test('filling places automatic dots on empty neighbours only', () => {
  const g = board();
  g.click(at(1, 2)); // manual dot right of (1,1)
  g.click(at(1, 1), true); // fill (1,1)
  assert.equal(g.cells[at(1, 1)], FILLED);
  assert.equal(g.cells[at(0, 1)], AUTO);
  assert.equal(g.cells[at(2, 1)], AUTO);
  assert.equal(g.cells[at(1, 0)], AUTO);
  assert.equal(g.cells[at(1, 2)], DOT, 'manual dot stays manual');
  assert.equal(g.cells[at(0, 0)], EMPTY, 'clue untouched');
});

test('unfilling removes only automatic dots that no longer touch a filled cell', () => {
  const g = board();
  g.click(at(1, 2)); // manual dot
  g.click(at(1, 1), true); // fill (1,1)
  g.click(at(2, 2), true); // fill (2,2): shares neighbours (1,2) manual and (2,1) auto
  g.click(at(1, 1)); // unfill (1,1)
  assert.equal(g.cells[at(1, 1)], EMPTY);
  assert.equal(g.cells[at(0, 1)], EMPTY, 'auto dot removed');
  assert.equal(g.cells[at(1, 0)], EMPTY, 'auto dot removed');
  assert.equal(g.cells[at(2, 1)], AUTO, 'auto dot still next to (2,2) stays');
  assert.equal(g.cells[at(1, 2)], DOT, 'manual dot stays');
});

test('a filled cell unfilled next to another filled cell becomes an automatic dot', () => {
  const g = board();
  g.click(at(1, 1), true);
  g.click(at(1, 2)); // auto dot → filled (adjacent: rule violation)
  assert.equal(g.cells[at(1, 2)], FILLED);
  assert.deepEqual([...g.analyze().adjacent].filter(Boolean).length, 2);
  g.click(at(1, 2)); // filled → would be empty, but it touches (1,1)
  assert.equal(g.cells[at(1, 2)], AUTO);
});

test('undo and redo restore whole strokes including automatic dots', () => {
  const g = board();
  g.click(at(2, 2), true);
  const after = Array.from(g.cells);
  assert.ok(g.undo());
  assert.ok(g.cells.every((v) => v === EMPTY));
  assert.ok(g.redo());
  assert.deepEqual(Array.from(g.cells), after);
  assert.ok(!g.redo());
});

test('each click is one undo step', () => {
  const g = board();
  g.click(at(3, 0));
  g.click(at(3, 1));
  g.click(at(3, 1));
  assert.deepEqual([0, 1].map((c) => g.cells[at(3, c)]), [DOT, FILLED]);
  assert.equal(g.history.length, 3);
  g.undo();
  assert.deepEqual([0, 1].map((c) => g.cells[at(3, c)]), [DOT, DOT]);
  assert.equal(g.cells[at(2, 1)], EMPTY, 'undo removed the automatic dot too');
});

test('checkpoints save and revert, and reverting is undoable', () => {
  const g = board();
  g.click(at(1, 1), true);
  const k = g.saveCheckpoint('', 1000);
  assert.equal(g.checkpoints[k].name, 'Checkpoint 1');
  assert.equal(g.checkpoints[k].filled, 1);
  const saved = Array.from(g.cells);
  g.click(at(3, 3), true);
  g.click(at(0, 3));
  assert.ok(g.revertCheckpoint(k));
  assert.deepEqual(Array.from(g.cells), saved);
  g.undo();
  assert.equal(g.cells[at(3, 3)], FILLED);
  g.saveCheckpoint('second');
  g.deleteCheckpoint(0);
  assert.deepEqual(g.checkpoints.map((c) => c.name), ['second']);
});

test('numbers grey out once dots reach the number, without shaded ends', () => {
  const g = board();
  g.click(at(0, 1));
  g.click(at(0, 2));
  assert.equal(g.analyze().clueState[0], CLUE_OPEN, '1 + 2 dots = 3 < 4');
  g.click(at(1, 0));
  assert.equal(g.analyze().clueState[0], CLUE_DONE, '1 + 2 dots right + 1 dot down = 4');
  g.click(at(0, 3));
  assert.equal(g.analyze().clueState[0], CLUE_ERROR, 'a fifth dot is too many');
});

test('numbers grey out exactly when satisfied and turn blue when impossible', () => {
  const g = board();
  // Clue 4 at (0,0) sees 7 cells with nothing filled.
  assert.equal(g.analyze().clueState[0], CLUE_OPEN);
  g.click(at(0, 2), true); // row view now 2 cells
  assert.equal(g.analyze().clueState[0], CLUE_OPEN);
  g.click(at(3, 0), true); // column view now 3 cells: total 2 + 3 - 1 = 4
  assert.equal(g.analyze().clueState[0], CLUE_DONE);
  g.click(at(2, 0)); // auto dot → filled: column view 2 cells, total 3 < 4
  assert.equal(g.analyze().clueState[0], CLUE_ERROR);
  g.undo();
  g.undo();
  // Dots making the certain view too long are also an error.
  g.click(at(0, 2)); // unfill
  for (const c of [1, 2, 3]) g.click(at(0, c));
  g.click(at(1, 0));
  assert.equal(g.analyze().clueState[0], CLUE_ERROR, '1 + 3 dots right + 1 dot down = 5 > 4');
});

test('cut-off areas are reported', () => {
  const g = board();
  g.click(at(2, 3), true);
  g.click(at(3, 2), true);
  const { isolated } = g.analyze();
  assert.equal(isolated[at(3, 3)], 1);
  assert.equal(isolated.reduce((a, b) => a + b, 0), 1);
});

test('entering the solution solves the puzzle; serialize round-trips', () => {
  const p = generate({ w: 8, h: 8, seed: 3, difficulty: 'easy' });
  const g = new Game(p);
  assert.ok(!g.analyze().solved);
  p.solution.forEach((b, i) => { if (b) g.click(i, true); });
  assert.ok(g.analyze().solved);
  g.saveCheckpoint('done');
  const copy = new Game(p, JSON.parse(JSON.stringify(g.serialize())));
  assert.deepEqual(Array.from(copy.cells), Array.from(g.cells));
  assert.equal(copy.checkpoints.length, 1);
  assert.ok(copy.analyze().solved);
});

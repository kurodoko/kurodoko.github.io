// Hints: point out mistakes, or where the next step can be found.
//
// A hint never says what follows or makes a move; it only shows where to
// look. It tries the simplest reasoning first (one number on its own, then
// connectivity, then a what-if) and prefers places near the last move.

import { Solver, BLACK, WHITE, UNKNOWN, TRIAL_BUDGET, SHORT_TRIAL_BUDGET } from './solver.js';
import { FILLED, DOT, AUTO } from './game.js';

/**
 * Player marks that contradict the solution: filled cells that are
 * unshaded, and the player's own dots on shaded cells. (Automatic dots
 * follow from the filled cells, so they are only wrong if a fill is.)
 */
export function findMistakes(game, solution) {
  const wrong = [];
  for (let i = 0; i < game.n; i++) {
    const v = game.cells[i];
    if ((v === FILLED && !solution[i]) || (v === DOT && solution[i])) wrong.push(i);
  }
  return wrong;
}

/** Undo until no mark is wrong (redo brings the moves back); else erase the wrong marks. */
export function rewindToCorrect(game, solution) {
  let undone = 0;
  while (findMistakes(game, solution).length && game.undo()) undone++;
  const wrong = findMistakes(game, solution);
  if (wrong.length) game.erase(wrong);
  return { undone, erased: wrong.length };
}

/**
 * Where to look next, assuming the marks are all correct. Returns
 * { kind: 'number', cell } for a number that on its own decides some
 * unmarked cell, { kind: 'area', cell } for a connectivity or what-if step
 * around cell, or null when the puzzle is solved.
 */
export function findHint(game) {
  if (game.analyze().solved) return null;
  const { w, h, n, cells, clues } = game;
  const s = new Solver(w, h).load(clues);
  for (let i = 0; i < n; i++) {
    if (clues[i]) continue;
    if (cells[i] === FILLED) s.set(i, BLACK);
    else if (cells[i] === DOT || cells[i] === AUTO) s.set(i, WHITE);
  }
  s.clearQueues();
  if (s.unknown === 0) return null;

  const order = nearestFirst(game);
  // 1. A number that decides something on its own.
  for (const p of order) {
    if (!clues[p]) continue;
    const m = s.mark();
    const deduced = s.evalClue(p) && s.tl > m.tl;
    s.rollback(m);
    if (deduced) return { kind: 'number', cell: p };
  }
  // 2. A cell whose shading would cut the unshaded cells apart.
  for (const i of order) if (s.st[i] === UNKNOWN && s.isCut(i)) return { kind: 'area', cell: i };
  // 3. A cell where assuming one value breaks a rule, short what-ifs first.
  for (const budget of [SHORT_TRIAL_BUDGET, TRIAL_BUDGET]) {
    s.trialBudget = budget;
    for (const i of order) {
      if (s.st[i] === UNKNOWN && (s.refutes(i, BLACK) || s.refutes(i, WHITE))) return { kind: 'area', cell: i };
    }
  }
  // Not reachable for generated puzzles; still point somewhere useful.
  return { kind: 'area', cell: order.find((i) => s.st[i] === UNKNOWN) };
}

/** All cells, nearest to the last move first (reading order without one). */
function nearestFirst({ w, n, lastMove }) {
  const all = Array.from({ length: n }, (_, i) => i);
  if (lastMove < 0) return all;
  const r0 = Math.floor(lastMove / w);
  const c0 = lastMove % w;
  const d = (i) => Math.abs(Math.floor(i / w) - r0) + Math.abs((i % w) - c0);
  return all.sort((a, b) => d(a) - d(b) || a - b);
}

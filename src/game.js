// Game state: what the player has marked, independent of any display.
//
// Each non-number cell is EMPTY, DOT (placed by the player), AUTO (a dot
// placed automatically) or FILLED. After every move the automatic dots are
// recomputed: a cell gets one when it touches a filled cell, and loses it
// when it no longer does. Player dots are never touched.

import { neighbourTable, components, isValidSolution } from './grid.js';

export const EMPTY = 0;
export const DOT = 1;
export const AUTO = 2;
export const FILLED = 3;

/** Clue display states from analyze(). */
export const CLUE_OPEN = 0;
export const CLUE_DONE = 1;
export const CLUE_ERROR = 2;

const isDot = (v) => v === DOT || v === AUTO;

/** Undo (and redo) steps kept when progress is saved. */
const SAVED_STEPS = 500;

/** Click cycle: empty → dot → filled → empty (reverse goes the other way). */
export function nextState(v, reverse = false) {
  if (reverse) return v === EMPTY ? FILLED : v === FILLED ? DOT : EMPTY;
  return v === EMPTY ? DOT : v === FILLED ? EMPTY : FILLED;
}

export class Game {
  constructor({ w, h, clues }, saved = null) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.clues = Array.from(clues);
    this.nb = neighbourTable(w, h);
    this.cells = new Uint8Array(this.n);
    this.history = [];
    this.future = [];
    this.checkpoints = [];
    this.changes = null;
    this.lastMove = -1;
    this.hints = 0;
    // Clock times (ms): when the puzzle was first set, and when it was solved (0: not).
    this.startedAt = Date.now();
    this.solvedAt = 0;
    if (saved) this.restore(saved);
    // Saves from older versions may hold automatic dots the rules no longer give.
    this.updateAutoDots();
  }

  // --- low-level writes -----------------------------------------------------

  write(i, v) {
    if (this.cells[i] === v) return;
    if (this.changes && !this.changes.has(i)) this.changes.set(i, this.cells[i]);
    this.cells[i] = v;
  }

  /** Run fn's writes, then bring the automatic dots up to date, as one undo step. */
  step(fn) {
    this.changes = new Map();
    fn();
    this.updateAutoDots();
    const changes = this.changes;
    this.changes = null;
    this.record(changes);
  }

  /** Cells that need an automatic dot (see the header comment). */
  autoDotCells() {
    const { n, cells, nb } = this;
    const need = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (cells[i] !== FILLED) continue;
      for (let d = 0; d < 4; d++) {
        const j = nb[4 * i + d];
        if (j >= 0) need[j] = 1;
      }
    }
    return need;
  }

  updateAutoDots() {
    const need = this.autoDotCells();
    for (let i = 0; i < this.n; i++) {
      if (this.clues[i]) continue;
      if (this.cells[i] === EMPTY && need[i]) this.write(i, AUTO);
      else if (this.cells[i] === AUTO && !need[i]) this.write(i, EMPTY);
    }
  }

  // --- player actions -------------------------------------------------------

  /** Click cell i: advance its state (with automatic dots) as one undo step. */
  click(i, reverse = false) {
    if (i < 0 || this.clues[i]) return false;
    this.lastMove = i;
    this.step(() => this.write(i, nextState(this.cells[i], reverse)));
    return true;
  }

  /** Clear the given cells (one undo step). */
  erase(list) {
    this.step(() => {
      for (const i of list) if (!this.clues[i]) this.write(i, EMPTY);
    });
  }

  /** Push the changes in old (cell → previous value) as one undo step. */
  record(old) {
    const group = [];
    for (const [i, v] of old) if (this.cells[i] !== v) group.push(i, v, this.cells[i]);
    if (group.length === 0) return;
    this.history.push(group);
    this.future.length = 0;
  }

  /** Replace every cell with values (one undo step). */
  replaceAll(values) {
    this.step(() => {
      for (let i = 0; i < this.n; i++) if (!this.clues[i]) this.write(i, values[i]);
    });
  }

  undo() {
    const group = this.history.pop();
    if (!group) return false;
    for (let k = group.length - 3; k >= 0; k -= 3) this.cells[group[k]] = group[k + 1];
    this.future.push(group);
    return true;
  }

  redo() {
    const group = this.future.pop();
    if (!group) return false;
    for (let k = 0; k < group.length; k += 3) this.cells[group[k]] = group[k + 2];
    this.history.push(group);
    return true;
  }

  reset() {
    this.replaceAll(new Uint8Array(this.n));
  }

  // --- checkpoints ----------------------------------------------------------

  saveCheckpoint(name, time = Date.now()) {
    const filled = this.cells.reduce((a, v) => a + (v === FILLED ? 1 : 0), 0);
    this.checkpoints.push({
      name: name || `Checkpoint ${this.checkpoints.length + 1}`,
      time,
      filled,
      cells: encodeCells(this.cells),
    });
    return this.checkpoints.length - 1;
  }

  revertCheckpoint(k) {
    const cp = this.checkpoints[k];
    if (!cp) return false;
    this.replaceAll(decodeCells(cp.cells, this.n));
    return true;
  }

  deleteCheckpoint(k) {
    this.checkpoints.splice(k, 1);
  }

  // --- rules ----------------------------------------------------------------

  /**
   * Rule check for display.
   *   clueState[i]  CLUE_DONE when the number plus the unbroken dots (or
   *                 numbers) around it reach exactly the number, i.e. every
   *                 cell it sees is dotted; CLUE_ERROR when it can no longer
   *                 be met.
   *   adjacent[i]   1 for filled cells touching another filled cell.
   *   isolated[i]   1 for unfilled cells cut off from the largest unfilled area.
   *   solved        every rule holds (unmarked cells count as unshaded).
   */
  analyze() {
    const { w, h, n, cells, clues, nb } = this;
    const adjacent = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (cells[i] !== FILLED) continue;
      for (let d = 0; d < 4; d++) {
        const j = nb[4 * i + d];
        if (j >= 0 && cells[j] === FILLED) adjacent[i] = adjacent[j] = 1;
      }
    }

    const isolated = new Uint8Array(n);
    const { comp, sizes } = components(w, h, (i) => cells[i] !== FILLED);
    if (sizes.length > 1) {
      let main = 0;
      for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[main]) main = k;
      for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== main) isolated[i] = 1;
    }

    const clueState = new Int8Array(n);
    let allDone = true;
    for (let p = 0; p < n; p++) {
      const target = clues[p];
      if (!target) continue;
      let max = 1;
      let min = 1;
      for (let d = 0; d < 4; d++) {
        let j = nb[4 * p + d];
        let sure = true;
        while (j >= 0 && cells[j] !== FILLED) {
          max++;
          if (sure && (isDot(cells[j]) || clues[j])) min++;
          else sure = false;
          j = nb[4 * j + d];
        }
      }
      if (min > target || max < target) clueState[p] = CLUE_ERROR;
      else if (min === target) clueState[p] = CLUE_DONE;
      if (max !== target) allDone = false;
    }

    const solved = allDone && sizes.length === 1 && !adjacent.includes(1)
      && isValidSolution(w, h, clues, Array.from(cells, (v) => v === FILLED));
    return { clueState, adjacent, isolated, solved };
  }

  // --- persistence ----------------------------------------------------------

  serialize({ withHistory = true } = {}) {
    const saved = {
      cells: encodeCells(this.cells),
      checkpoints: this.checkpoints,
      hints: this.hints,
      startedAt: this.startedAt,
      solvedAt: this.solvedAt,
    };
    if (withHistory) {
      saved.history = this.history.slice(-SAVED_STEPS);
      saved.future = this.future.slice(-SAVED_STEPS);
    }
    return saved;
  }

  restore(saved) {
    if (typeof saved.cells === 'string' && saved.cells.length === this.n) {
      this.cells = decodeCells(saved.cells, this.n);
      for (let i = 0; i < this.n; i++) if (this.clues[i]) this.cells[i] = EMPTY;
    }
    if (Number.isInteger(saved.hints) && saved.hints > 0) this.hints = saved.hints;
    if (Number.isFinite(saved.startedAt) && saved.startedAt > 0) this.startedAt = saved.startedAt;
    if (Number.isFinite(saved.solvedAt) && saved.solvedAt >= this.startedAt) this.solvedAt = saved.solvedAt;
    this.history = this.checkedSteps(saved.history, false);
    this.future = this.checkedSteps(saved.future, true);
    if (Array.isArray(saved.checkpoints)) {
      this.checkpoints = saved.checkpoints.filter((cp) => typeof cp.cells === 'string' && cp.cells.length === this.n);
    }
  }

  /**
   * Saved undo (or redo) steps, if they fit the current cells exactly:
   * walking back through history (or forward through redo) every step must
   * find the values it expects. Anything else (another version, a damaged
   * save) is dropped rather than risk an undo corrupting the board.
   */
  checkedSteps(steps, redo) {
    if (!Array.isArray(steps)) return [];
    const cells = Uint8Array.from(this.cells);
    const ok = (v) => Number.isInteger(v) && v >= EMPTY && v <= FILLED;
    for (let s = steps.length - 1; s >= 0; s--) {
      const g = steps[s];
      if (!Array.isArray(g) || g.length === 0 || g.length % 3) return [];
      for (let k = 0; k < g.length; k += 3) {
        const [i, before, after] = [g[k], g[k + 1], g[k + 2]];
        if (!Number.isInteger(i) || i < 0 || i >= this.n || this.clues[i] || !ok(before) || !ok(after)) return [];
        if (cells[i] !== (redo ? before : after)) return [];
        cells[i] = redo ? after : before;
      }
    }
    return steps;
  }
}

/** Milliseconds as hh:mm:ss (hours keep counting past 99). */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

export function encodeCells(cells) {
  return Array.from(cells, (v) => String(v)).join('');
}

export function decodeCells(s, n) {
  const cells = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = s.charCodeAt(i) - 48;
    cells[i] = v >= 0 && v <= 3 ? v : EMPTY;
  }
  return cells;
}

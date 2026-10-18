// Game state: what the player has marked, independent of any display.
//
// Each non-number cell is EMPTY, DOT (placed by the player), AUTO (a dot
// placed automatically) or FILLED. After every move the automatic dots are
// recomputed: a cell gets one when it touches a filled cell, or when a number
// sees it and filled cells (or the edge) close that number's view at exactly
// its count. Automatic dots whose reason has gone are removed. Player dots
// are never touched.

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
    if (saved) this.restore(saved);
  }

  // --- low-level writes -----------------------------------------------------

  write(i, v) {
    if (this.cells[i] === v) return;
    if (this.changes && !this.changes.has(i)) this.changes.set(i, this.cells[i]);
    this.cells[i] = v;
  }

  /** Set one cell, then bring the automatic dots up to date. */
  setState(i, target) {
    if (this.clues[i]) return;
    this.write(i, target);
    this.updateAutoDots();
  }

  /** Cells that need an automatic dot (see the header comment). */
  autoDotCells() {
    const { n, cells, clues, nb } = this;
    const need = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (cells[i] !== FILLED) continue;
      for (let d = 0; d < 4; d++) {
        const j = nb[4 * i + d];
        if (j >= 0) need[j] = 1;
      }
    }
    for (let p = 0; p < n; p++) {
      if (!clues[p]) continue;
      let seen = 1;
      for (let d = 0; d < 4; d++) {
        for (let j = nb[4 * p + d]; j >= 0 && cells[j] !== FILLED; j = nb[4 * j + d]) seen++;
      }
      if (seen !== clues[p]) continue;
      for (let d = 0; d < 4; d++) {
        for (let j = nb[4 * p + d]; j >= 0 && cells[j] !== FILLED; j = nb[4 * j + d]) need[j] = 1;
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
    this.changes = new Map();
    this.setState(i, nextState(this.cells[i], reverse));
    const changes = this.changes;
    this.changes = null;
    this.record(changes);
    return true;
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
    const old = new Map();
    for (let i = 0; i < this.n; i++) {
      if (this.cells[i] !== values[i]) {
        old.set(i, this.cells[i]);
        this.cells[i] = values[i];
      }
    }
    this.record(old);
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
   *   clueState[i]  CLUE_DONE as soon as the number plus the unbroken dots
   *                 (or numbers) around it reach exactly the number, or when
   *                 the count to the first filled cell or edge in each
   *                 direction is exactly the number; CLUE_ERROR when it can no
   *                 longer be met.
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
      else if (min === target || max === target) clueState[p] = CLUE_DONE;
      if (max !== target) allDone = false;
    }

    const solved = allDone && sizes.length === 1 && !adjacent.includes(1)
      && isValidSolution(w, h, clues, Array.from(cells, (v) => v === FILLED));
    return { clueState, adjacent, isolated, solved };
  }

  // --- persistence ----------------------------------------------------------

  serialize() {
    return { cells: encodeCells(this.cells), checkpoints: this.checkpoints };
  }

  restore(saved) {
    if (typeof saved.cells === 'string' && saved.cells.length === this.n) {
      this.cells = decodeCells(saved.cells, this.n);
      for (let i = 0; i < this.n; i++) if (this.clues[i]) this.cells[i] = EMPTY;
    }
    if (Array.isArray(saved.checkpoints)) {
      this.checkpoints = saved.checkpoints.filter((cp) => typeof cp.cells === 'string' && cp.cells.length === this.n);
    }
  }
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

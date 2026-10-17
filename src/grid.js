// Grid helpers shared by the solver, generator and game.
//
// Cells are indexed row-major: i = r * w + c. Directions are up, down, left,
// right in that order everywhere.

export const MIN_SIZE = 4;
export const MAX_SIZE = 60;

const tables = new Map();

/** Neighbour table: nb[4 * i + d] is the cell in direction d from i, or -1. */
export function neighbourTable(w, h) {
  const key = w + 'x' + h;
  let nb = tables.get(key);
  if (nb) return nb;
  nb = new Int32Array(4 * w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      nb[4 * i] = r > 0 ? i - w : -1;
      nb[4 * i + 1] = r < h - 1 ? i + w : -1;
      nb[4 * i + 2] = c > 0 ? i - 1 : -1;
      nb[4 * i + 3] = c < w - 1 ? i + 1 : -1;
    }
  }
  tables.set(key, nb);
  return nb;
}

/** Column label: A..Z, AA..AZ, BA.. (spreadsheet style). */
export function columnName(c) {
  let s = '';
  c += 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

export function cellName(w, i) {
  return columnName(i % w) + (Math.floor(i / w) + 1);
}

/**
 * Count cells visible from i (including i) given a predicate isBlocked(j).
 * Visibility runs in the four directions until a blocked cell or the edge.
 */
export function visibleCount(w, h, i, isBlocked) {
  const nb = neighbourTable(w, h);
  let count = 1;
  for (let d = 0; d < 4; d++) {
    let j = nb[4 * i + d];
    while (j >= 0 && !isBlocked(j)) {
      count++;
      j = nb[4 * j + d];
    }
  }
  return count;
}

/**
 * Label the connected components of cells where include(i) is true.
 * Returns { comp: Int32Array (-1 for excluded cells), sizes: number[] }.
 */
export function components(w, h, include) {
  const n = w * h;
  const nb = neighbourTable(w, h);
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || !include(s)) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const v = queue[head++];
      for (let d = 0; d < 4; d++) {
        const u = nb[4 * v + d];
        if (u >= 0 && comp[u] < 0 && include(u)) {
          comp[u] = id;
          queue[tail++] = u;
        }
      }
    }
    sizes.push(tail);
  }
  return { comp, sizes };
}

/**
 * Full rule check of a finished grid, independent of the solver.
 * clues: number per cell (0 = none); black: truthy per shaded cell.
 */
export function isValidSolution(w, h, clues, black) {
  const n = w * h;
  const nb = neighbourTable(w, h);
  for (let i = 0; i < n; i++) {
    if (!black[i]) continue;
    if (clues[i]) return false;
    for (let d = 0; d < 4; d++) {
      const j = nb[4 * i + d];
      if (j >= 0 && black[j]) return false;
    }
  }
  if (components(w, h, (i) => !black[i]).sizes.length !== 1) return false;
  for (let i = 0; i < n; i++) {
    if (clues[i] && visibleCount(w, h, i, (j) => black[j]) !== clues[i]) return false;
  }
  return true;
}

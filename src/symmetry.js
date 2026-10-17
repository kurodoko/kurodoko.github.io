// Symmetry groups, orbits and layout scores.
//
// The generator places shaded cells and numbers orbit by orbit, but keeps each
// extra orbit member only with some probability, so symmetry is loose rather
// than exact. These scores reward candidates that still read as symmetric or
// as built from a repeated motif.

/** Index maps for the non-identity transforms valid on a w×h grid. */
export function transformMaps(w, h) {
  const defs = {
    rot2: (r, c) => [h - 1 - r, w - 1 - c],
    flipH: (r, c) => [r, w - 1 - c],
    flipV: (r, c) => [h - 1 - r, c],
  };
  if (w === h) {
    defs.diag = (r, c) => [c, r];
    defs.anti = (r, c) => [w - 1 - c, w - 1 - r];
    defs.rot90 = (r, c) => [c, w - 1 - r];
    defs.rot270 = (r, c) => [w - 1 - c, r];
  }
  const maps = {};
  for (const [name, f] of Object.entries(defs)) {
    const m = new Int32Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const [r2, c2] = f(r, c);
        m[r * w + c] = r2 * w + c2;
      }
    }
    maps[name] = m;
  }
  return maps;
}

/** Symmetry groups as lists of their non-identity transforms. */
const GROUPS = {
  rot2: ['rot2'],
  flipH: ['flipH'],
  flipV: ['flipV'],
  dihedral: ['flipH', 'flipV', 'rot2'],
  rot4: ['rot90', 'rot2', 'rot270'],
  diag: ['diag'],
};

/** Groups usable on this grid, with selection weights (rot2 is the Nikoli classic). */
export function availableGroups(w, h) {
  const list = [['rot2', 4], ['flipH', 1], ['flipV', 1], ['dihedral', 1]];
  if (w === h) list.push(['rot4', 2], ['diag', 1]);
  return list;
}

/** Partition all cells into orbits under the named group. */
export function orbits(w, h, group) {
  const maps = transformMaps(w, h);
  const ts = GROUPS[group].map((name) => maps[name]);
  const seen = new Uint8Array(w * h);
  const result = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i]) continue;
    const orbit = [i];
    seen[i] = 1;
    for (const t of ts) {
      const j = t[i];
      if (!seen[j]) {
        seen[j] = 1;
        orbit.push(j);
      }
    }
    orbit.sort((a, b) => a - b);
    result.push(orbit);
  }
  return result;
}

/** Best fraction of marked cells whose image under one transform is also marked. */
export function symmetryScore(w, h, mask) {
  const maps = transformMaps(w, h);
  let total = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) total++;
  if (total === 0) return 0;
  let best = 0;
  for (const m of Object.values(maps)) {
    let hit = 0;
    for (let i = 0; i < w * h; i++) if (mask[i] && mask[m[i]]) hit++;
    best = Math.max(best, hit / total);
  }
  return best;
}

/**
 * Repeated-motif score: how much better than chance the best translation
 * (at least 3 steps away, so trivial diagonal chains don't count) maps marked
 * cells onto marked cells. 0 = no better than random, 1 = perfect tiling.
 */
export function motifScore(w, h, mask) {
  let total = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) total++;
  const density = total / (w * h);
  if (total === 0 || density >= 1) return 0;
  let best = 0;
  for (let dr = 0; dr <= 6; dr++) {
    for (let dc = -6; dc <= 6; dc++) {
      if (Math.abs(dr) + Math.abs(dc) < 3 || (dr === 0 && dc < 0)) continue;
      let hit = 0;
      let count = 0;
      for (let r = 0; r + dr < h; r++) {
        for (let c = Math.max(0, -dc); c < w && c + dc < w; c++) {
          if (!mask[r * w + c]) continue;
          count++;
          if (mask[(r + dr) * w + c + dc]) hit++;
        }
      }
      if (count < 4) continue;
      best = Math.max(best, (hit / count - density) / (1 - density));
    }
  }
  return best;
}

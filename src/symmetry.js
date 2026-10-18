// Symmetry groups, orbits and symmetry scores.
//
// The generator places numbers orbit by orbit, adding each extra orbit member
// only with some probability, so their positions are loosely symmetric. The
// shading is random; symmetryScore is also used to reject candidates whose
// shading happens to look symmetric.

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

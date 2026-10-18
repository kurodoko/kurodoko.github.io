// Puzzle generator.
//
// generate({ w, h, seed, difficulty }) is a pure function of its inputs: the
// same arguments give the same puzzle in any browser or in Node. Changing
// anything that alters the output must bump GENERATOR_VERSION so old links can
// say they were made by a different version.
//
// Steps per candidate:
//   1. Shade cells at random (no two adjacent, unshaded cells connected).
//      The shading is deliberately not symmetric: symmetric or repeated
//      shading makes parts of the puzzle copies of each other.
//      Only the positions of the numbers follow a (very loose) symmetry.
//   2. Add numbers one orbit at a time until the deductive solver finishes,
//      then remove numbers it can do without (orbits first, then singles).
//      Both happen ring by ring from the border inward; see chooseClues.
//   3. Easy and medium add back redundant numbers in proportion.
// Several candidates are built for small grids and the best scoring one wins:
// loosely symmetric number positions, no accidental shading symmetry, few
// numbers.

import { Rng } from './rng.js';
import { Solver, CONNECT, TRIAL, UNKNOWN, BLACK, WHITE, TRIAL_BUDGET, SHORT_TRIAL_BUDGET } from './solver.js';
import { neighbourTable, visibleCount, MIN_SIZE, MAX_SIZE } from './grid.js';
import { availableGroups, orbits, symmetryScore } from './symmetry.js';

export const GENERATOR_VERSION = 3;

export const DIFFICULTIES = {
  // level: strongest solving technique allowed.
  // extra: redundant numbers kept, as a fraction of the minimal set.
  // candidateCells: build about candidateCells / (w*h) candidates (1 to 6).
  // trialBudget: number checks a what-if may follow before its contradiction.
  // cellsPerWhatIf: allow about one what-if step per this many cells (0: no limit).
  easy: { level: CONNECT, extra: 0.6, candidateCells: 900 },
  medium: { level: CONNECT, extra: 0.25, candidateCells: 900 },
  hard: { level: TRIAL, extra: 0, candidateCells: 400, trialBudget: SHORT_TRIAL_BUDGET, cellsPerWhatIf: 150 },
  fiendish: { level: TRIAL, extra: 0, candidateCells: 400, trialBudget: TRIAL_BUDGET, cellsPerWhatIf: 0 },
};

/** Probability of adding each further member of a number's symmetry orbit. */
const PARTNER = 0.5;

/**
 * Number-position symmetry: a hint gives the puzzle shape, exactness is dull.
 * It earns score up to SYMMETRY_CAP and loses score above SYMMETRY_EXACT.
 */
const SYMMETRY_CAP = 0.6;
const SYMMETRY_EXACT = 0.8;

/** Shading symmetry above this (chance is about the shading density) is penalised. */
const SHADING_SYMMETRY_LIMIT = 0.35;

/**
 * Longest straight run of unshaded cells. Keeps every number at most
 * 15 + 15 + 1 = 31: easier to count on screen, and the solver's fast path.
 */
const MAX_RUN = 16;

/** Width of the border-distance rings the clue phases work through. */
const RING_WIDTH = 5;

/** Hard: largest gap a removed number may leave for contradiction search to close. */
const HOLE_MAX = 16;

/** Hard grids up to this many cells let a removal leave a gap of any size. */
const ANY_HOLE_CELLS = 400;

export function checkParams({ w, h, seed, difficulty }) {
  for (const [name, v] of [['width', w], ['height', h]]) {
    if (!Number.isInteger(v) || v < MIN_SIZE || v > MAX_SIZE) {
      throw new Error(`${name} must be an integer from ${MIN_SIZE} to ${MAX_SIZE}`);
    }
  }
  if (!/^-?\d{1,15}$/.test(String(seed))) throw new Error('seed must be an integer');
  if (!DIFFICULTIES[difficulty]) throw new Error(`difficulty must be one of ${Object.keys(DIFFICULTIES).join(', ')}`);
}

export function generate({ w, h, seed, difficulty = 'medium', onProgress = () => {} }) {
  checkParams({ w, h, seed, difficulty });
  const spec = DIFFICULTIES[difficulty];
  const rng = new Rng('kurodoko', GENERATOR_VERSION, w, h, String(seed), difficulty);
  // Candidates to choose the best-looking from; what-if levels cost more to build.
  const tries = Math.max(1, Math.min(6, Math.floor(spec.candidateCells / (w * h))));
  let best = null;
  for (let t = 0; t < tries; t++) {
    const progress = (f) => onProgress((t + f) / tries);
    const cand = buildCandidate(w, h, spec, rng.fork('candidate ' + t), progress);
    if (!best || cand.score > best.score) best = cand;
  }
  onProgress(1);
  return {
    version: GENERATOR_VERSION,
    w,
    h,
    seed: String(seed),
    difficulty,
    clues: Array.from(best.clues),
    solution: Array.from(best.black),
    score: best.score,
    layout: best.layout,
  };
}

function buildCandidate(w, h, spec, rng, progress) {
  const groups = availableGroups(w, h);
  const group = groups[rng.weighted(groups.map((g) => g[1]))][0];
  const orb = orbits(w, h, group);
  const shading = randomShading(w, h, rng.fork('layout'));
  breakLongRuns(shading, rng.fork('runs'));
  const black = shading.black;
  progress(0.05);
  const { clues, needsTrial } = chooseClues(w, h, black, orb, spec, rng.fork('clues'), (f) => progress(0.05 + 0.95 * f));

  const clueMask = Array.from(clues, (v) => (v ? 1 : 0));
  let clueCount = 0;
  let whiteCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (clues[i]) clueCount++;
    if (!black[i]) whiteCount++;
  }
  const clueSym = symmetryScore(w, h, clueMask);
  const score =
    Math.min(SYMMETRY_CAP, clueSym) -
    2 * Math.max(0, clueSym - SYMMETRY_EXACT) -
    Math.max(0, symmetryScore(w, h, black) - SHADING_SYMMETRY_LIMIT) -
    0.5 * (clueCount / whiteCount) +
    (spec.level === TRIAL && needsTrial ? 0.3 : 0);
  return { clues, black, score, layout: group };
}

/** Incrementally builds a valid shading: no adjacent shaded cells, unshaded connected. */
class Shading {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.nb = neighbourTable(w, h);
    this.black = new Uint8Array(this.n);
    this.count = 0;
    this.seen = new Int32Array(this.n);
    this.stamp = 0;
    this.queue = new Int32Array(this.n);
  }

  open(r, c) {
    return r >= 0 && r < this.h && c >= 0 && c < this.w && !this.black[r * this.w + c];
  }

  canPlace(i) {
    const { nb, black } = this;
    if (black[i]) return false;
    for (let d = 0; d < 4; d++) {
      const j = nb[4 * i + d];
      if (j >= 0 && black[j]) return false;
    }
    return !this.splits(i);
  }

  place(i) {
    this.black[i] = 1;
    this.count++;
  }

  /** Would shading i disconnect the unshaded cells? */
  splits(i) {
    const { w } = this;
    const r = Math.floor(i / w);
    const c = i % w;
    // Ring of the 8 surrounding cells, clockwise from north; even slots are orthogonal.
    const ring = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];
    const open = ring.map(([dr, dc]) => this.open(r + dr, c + dc));
    let orth = 0;
    for (let k = 0; k < 8; k += 2) if (open[k]) orth++;
    if (orth <= 1 || open.every(Boolean)) return false;
    // If every open orthogonal neighbour lies in one run of open ring cells,
    // they stay connected around i.
    let runsWithOrth = 0;
    for (let k = 0; k < 8; k++) {
      if (!open[k] || open[(k + 7) % 8]) continue;
      let hasOrth = false;
      for (let m = k; m < k + 8 && open[m % 8]; m++) if (m % 2 === 0) hasOrth = true;
      if (hasOrth) runsWithOrth++;
    }
    if (runsWithOrth <= 1) return false;
    return !this.connectedWithout(i);
  }

  connectedWithout(i) {
    const { nb, black, seen, queue } = this;
    const targets = [];
    for (let d = 0; d < 4; d++) {
      const j = nb[4 * i + d];
      if (j >= 0 && !black[j]) targets.push(j);
    }
    const stamp = ++this.stamp;
    seen[i] = stamp;
    let head = 0;
    let tail = 0;
    queue[tail++] = targets[0];
    seen[targets[0]] = stamp;
    let found = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let d = 0; d < 4; d++) {
        const u = nb[4 * v + d];
        if (u < 0 || black[u] || seen[u] === stamp) continue;
        seen[u] = stamp;
        if (targets.includes(u) && ++found === targets.length) return true;
        queue[tail++] = u;
      }
    }
    return false;
  }
}

function targetCount(w, h, rng) {
  return Math.round(w * h * (0.17 + 0.07 * rng.float()));
}

/** Random shading: no symmetry, no repeated patterns. */
function randomShading(w, h, rng) {
  const s = new Shading(w, h);
  const target = targetCount(w, h, rng);
  for (const i of rng.shuffle(Array.from({ length: w * h }, (_, i) => i))) {
    if (s.count >= target) break;
    if (s.canPlace(i)) s.place(i);
  }
  return s;
}

/** Shade cells inside runs longer than MAX_RUN. */
function breakLongRuns(s, rng) {
  const { w, h, black } = s;
  const lines = [];
  for (let r = 0; r < h; r++) lines.push(Array.from({ length: w }, (_, c) => r * w + c));
  for (let c = 0; c < w; c++) lines.push(Array.from({ length: h }, (_, r) => r * w + c));
  for (let changed = true; changed;) {
    changed = false;
    for (const line of lines) {
      for (let a = 0; a < line.length;) {
        if (black[line[a]]) { a++; continue; }
        let b = a;
        while (b + 1 < line.length && !black[line[b + 1]]) b++;
        if (b - a + 1 > MAX_RUN) {
          const mid = (a + b) / 2 + rng.int(7) - 3;
          const order = [];
          for (let q = a + 2; q <= b - 2; q++) order.push(q);
          order.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y);
          for (const q of order) {
            const i = line[q];
            if (!s.canPlace(i)) continue;
            s.place(i);
            changed = true;
            break;
          }
        }
        a = b + 1;
      }
    }
  }
}

/**
 * Choose the numbers for a shading, in stages from the border inward.
 *
 * Kurodoko solves naturally from the edges in, and every symmetry used keeps
 * a cell's distance to the border, so orbits never straddle rings. Stage k
 * adds numbers (Phase A) until the solver determines every cell in rings
 * 0..k, then prunes the numbers it added (Phase B) with rings 0..k-1 settled.
 * Keeping each stage's work inside its ring is what makes 60×60 fast: a
 * removal test only ever re-derives part of one ring, never the whole grid.
 * Grids up to 10×10 are a single stage, so there pruning is fully global.
 */
function chooseClues(w, h, black, orb, spec, rng, progress) {
  const n = w * h;
  const nb = neighbourTable(w, h);
  const whatIf = spec.level === TRIAL;
  const value = new Int16Array(n);
  for (let i = 0; i < n; i++) if (!black[i]) value[i] = visibleCount(w, h, i, (j) => black[j]);
  const orbitOf = new Int32Array(n);
  orb.forEach((o, k) => { for (const i of o) orbitOf[i] = k; });

  const ring = new Int32Array(n);
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / w);
    const c = i % w;
    ring[i] = Math.min(r, c, h - 1 - r, w - 1 - c);
    maxDist = Math.max(maxDist, ring[i]);
  }
  const stages = Math.ceil((maxDist + 1) / RING_WIDTH);
  const whitesIn = Array.from({ length: stages }, () => []);
  const whites = [];
  for (let i = 0; i < n; i++) {
    ring[i] = Math.min(stages - 1, Math.floor(ring[i] / RING_WIDTH));
    if (!black[i]) {
      whites.push(i);
      whitesIn[ring[i]].push(i);
    }
  }

  // Hard: contradiction search only on the gaps left by removed numbers (see
  // greedyRemove). Small grids can afford gaps of any size.
  const holeMax = !whatIf ? 0 : n <= ANY_HOLE_CELLS ? n : HOLE_MAX;
  const whatIfs = { left: spec.cellsPerWhatIf ? Math.ceil(n / spec.cellsPerWhatIf) : Infinity };
  const clues = new Int16Array(n);
  const solver = new Solver(w, h).load(clues);
  solver.zoneOnly = whatIf;
  if (spec.trialBudget) solver.trialBudget = spec.trialBudget;
  const run = () => {
    if (!solver.run(spec.level)) throw new Error('generator: contradiction');
  };
  const target = new Uint8Array(n);

  // Unknown cells a number at i would speak about directly.
  const info = (i, all) => {
    const st = solver.st;
    const counts = (j) => st[j] === UNKNOWN && (all || target[j]);
    let score = counts(i) ? 1 : 0;
    for (let d = 0; d < 4; d++) {
      let j = nb[4 * i + d];
      while (j >= 0) {
        if (counts(j)) score++;
        if (black[j]) break;
        j = nb[4 * j + d];
      }
    }
    return score;
  };
  // Cells a number at p speaks about: its row and column out to the first
  // shaded cell, and their neighbours. Where a removed number leaves a gap,
  // this is where a what-if step can close it.
  const nearCells = (group) => {
    const out = new Set();
    const add = (j) => {
      out.add(j);
      for (let e = 0; e < 4; e++) if (nb[4 * j + e] >= 0) out.add(nb[4 * j + e]);
    };
    for (const p of group) {
      add(p);
      for (let d = 0; d < 4; d++) {
        for (let j = nb[4 * p + d]; j >= 0; j = nb[4 * j + d]) {
          add(j);
          if (black[j]) break;
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  };
  const pick = (k) => {
    let best = -1;
    let bestScore = 0;
    const consider = (i, all) => {
      if (clues[i]) return;
      const sc = info(i, all);
      if (sc > bestScore) { bestScore = sc; best = i; }
    };
    const pool = whitesIn[k];
    for (let s = 0; s < 12 && pool.length; s++) consider(pool[rng.int(pool.length)], false);
    if (best < 0) for (const i of whites) if (ring[i] >= k) consider(i, false);
    if (best < 0) for (const i of whites) consider(i, false);
    if (best < 0) for (const i of whites) consider(i, true);
    if (best < 0) throw new Error('generator: no useful number left');
    return best;
  };
  // Add numbers (with loose symmetric partners) until the target is solved.
  const complete = (k) => {
    const added = [];
    while (solver.targetUnknown > 0) {
      const i = pick(k);
      for (const j of [i, ...orb[orbitOf[i]]]) {
        if (clues[j] || black[j] || (j !== i && !rng.chance(PARTNER))) continue;
        clues[j] = value[j];
        added.push(j);
        solver.addClue(j, value[j]);
      }
      run();
    }
    return added;
  };

  for (let k = 0; k < stages; k++) {
    const p0 = k / stages;
    const span = 1 / stages;
    for (let i = 0; i < n; i++) target[i] = ring[i] <= k ? 1 : 0;
    solver.setTarget(target);
    const root = solver.mark();

    // Phase A: add numbers until rings 0..k are determined.
    const stageClues = complete(k);
    progress(p0 + 0.1 * span);

    // Order removal tests latest-used first: in a fresh solve of this stage,
    // when does each number first deduce something? Minimal puzzles solve as
    // a chain; testing the end of the chain first keeps cascades short.
    solver.rollback(root);
    for (const i of stageClues) {
      solver.firstUse[i] = n + 1;
      solver.addClue(i, clues[i]);
    }
    run();
    const used = new Map(stageClues.map((i) => [i, solver.firstUse[i]]));
    solver.rollback(root);

    // Phase B: drop numbers the solver can do without, whole orbits first.
    // Singles break symmetry, so only the what-if levels (which must be
    // minimal) always try them.
    const byOrbit = new Map();
    for (const i of stageClues) {
      if (!byOrbit.has(orbitOf[i])) byOrbit.set(orbitOf[i], []);
      byOrbit.get(orbitOf[i]).push(i);
    }
    const groups = rng.shuffle([...byOrbit.values()].map((members) => ({
      key: Math.min(...members.map((i) => used.get(i))),
      members,
    }))).sort((a, b) => b.key - a.key);
    const opts = { level: spec.level, holeMax, nearCells, whatIfs };
    const removed = greedyRemove(solver, clues, groups.map((g) => g.members), opts,
      (f) => progress(p0 + (0.1 + 0.6 * f) * span));

    const singles = [];
    groups.forEach((g, gi) => {
      if (removed[gi]) return;
      for (const i of g.members) {
        if (g.members.length > 1 && (whatIf || rng.chance(0.3))) singles.push(i);
        else solver.addClue(i, clues[i]);
      }
    });
    run();
    singles.sort((a, b) => used.get(b) - used.get(a));
    greedyRemove(solver, clues, singles.map((i) => [i]), opts,
      (f) => progress(p0 + (0.7 + 0.3 * f) * span));
    for (const i of singles) if (clues[i]) solver.addClue(i, clues[i]);
    run();
    // Re-deriving in one go can differ from the removal path when contradiction
    // search is involved; top up in the rare case it falls short.
    complete(k);
  }

  // Levels with a what-if allowance: make sure the finished puzzle keeps to it.
  if (whatIf && spec.cellsPerWhatIf) {
    limitWhatIfs(w, h, clues, value, black, Math.ceil(n / spec.cellsPerWhatIf), spec.trialBudget);
  }

  // Phase C: easy and medium keep some redundant numbers, placed at random.
  let minimal = 0;
  for (let i = 0; i < n; i++) if (clues[i]) minimal++;
  const extra = Math.round(spec.extra * minimal);
  const free = whites.filter((i) => !clues[i]);
  for (const i of rng.shuffle(free).slice(0, extra)) clues[i] = value[i];
  progress(1);
  return { clues, needsTrial: whatIf && !solver.load(clues).solve(CONNECT) };
}

/**
 * Solve the puzzle the way a person would: normal reasoning (CONNECT) until
 * stuck, then one short what-if, counted. Once the allowance is used up,
 * being stuck puts back the number that would tell the most about the
 * undecided cells instead. The removal phase counts what-ifs only
 * approximately (earlier ones can quietly help close later gaps); this pass
 * makes the limit exact. Adding numbers keeps the solution unique.
 * Returns the number of what-ifs the solve used.
 */
function limitWhatIfs(w, h, clues, value, black, allowance, budget) {
  // A capped what-if is not monotone (more numbers can use up its steps on
  // other checks), so repeat from scratch until a pass needs no additions.
  for (;;) {
    const { used, added } = whatIfPass(w, h, clues, value, black, allowance, budget);
    if (!added) return used;
  }
}

function whatIfPass(w, h, clues, value, black, allowance, budget) {
  const n = w * h;
  const nb = neighbourTable(w, h);
  const s = new Solver(w, h).load(clues);
  s.trialBudget = budget;
  const info = (i) => {
    let score = s.st[i] === UNKNOWN ? 1 : 0;
    for (let d = 0; d < 4; d++) {
      for (let j = nb[4 * i + d]; j >= 0; j = nb[4 * j + d]) {
        if (s.st[j] === UNKNOWN) score++;
        if (black[j]) break;
      }
    }
    return score;
  };
  let used = 0;
  let added = 0;
  for (;;) {
    if (!s.run(CONNECT)) throw new Error('generator: contradiction');
    if (s.unknown === 0) return { used, added };
    let found = false;
    for (let i = 0; i < n && used < allowance && !found; i++) {
      if (s.st[i] !== UNKNOWN) continue;
      for (const v of [BLACK, WHITE]) {
        if (s.refutes(i, v)) {
          s.set(i, v === BLACK ? WHITE : BLACK);
          used++;
          found = true;
          break;
        }
      }
    }
    if (found) continue;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < n; i++) {
      if (black[i] || clues[i]) continue;
      const sc = info(i);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    if (best < 0) throw new Error('generator: no number left to add');
    clues[best] = value[best];
    s.addClue(best, value[best]);
    added++;
  }
}

/**
 * Greedy removal: for each group in order, drop it if the numbers present at
 * that point still let the solver determine every target cell. Equivalent to
 * re-solving after each removal, but done by divide and conquer over the
 * order: a node for range [l, r] holds the solved state of (current state +
 * kept groups before l + all groups after r), and children extend it
 * incrementally then roll back. Uniqueness holds throughout because every set
 * kept contains a set the solver finished.
 *
 * With holeMax, a removal that leaves at most that many unknown cells may still
 * succeed if contradiction search on just those cells closes the hole; the
 * cells it settled join the solver's zone so later states keep closing it.
 * nearCells(group) gives the cells to search for a removed group.
 *
 * The solver must be at the base state on entry and is returned to it.
 * Returns removed flags and clears removed numbers from clues.
 */
function greedyRemove(solver, clues, groups, { level, holeMax, nearCells, whatIfs }, progress) {
  const G = groups.length;
  const removed = new Uint8Array(G);
  if (G === 0) return removed;
  let leaves = 0;
  const run = () => {
    if (!solver.run(level)) throw new Error('generator: contradiction');
  };
  const add = (k) => {
    for (const i of groups[k]) solver.addClue(i, clues[i]);
  };
  const closesHole = (group) => {
    if (!holeMax || whatIfs.left <= 0 || solver.targetUnknown > holeMax) return false;
    const zl = solver.zoneLen;
    const m = solver.mark();
    for (const i of nearCells(group)) if (solver.st[i] === UNKNOWN) solver.addZone(i);
    const hits = (solver.trialHits = []);
    run();
    solver.trialHits = null;
    // Each contradiction it took counts against the puzzle's what-if allowance.
    const ok = solver.targetUnknown === 0 && hits.length <= whatIfs.left;
    if (ok) whatIfs.left -= hits.length;
    solver.rollback(m);
    // Keep just the cells contradiction actually settled: replaying those
    // re-closes the hole in later states without searching the rest.
    solver.truncateZone(zl);
    if (ok) for (const i of hits) solver.addZone(i);
    return ok;
  };
  const rec = (l, r) => {
    if (l === r || solver.targetUnknown === 0) {
      if (solver.targetUnknown === 0) removed.fill(1, l, r + 1);
      else if (closesHole(groups[l])) removed[l] = 1;
      leaves += r - l + 1;
      progress(leaves / G);
      return;
    }
    const mid = (l + r) >> 1;
    const m = solver.mark();
    for (let k = mid + 1; k <= r; k++) add(k);
    run();
    rec(l, mid);
    solver.rollback(m);
    for (let k = l; k <= mid; k++) if (!removed[k]) add(k);
    run();
    rec(mid + 1, r);
    solver.rollback(m);
  };
  rec(0, G - 1);
  for (let k = 0; k < G; k++) if (removed[k]) for (const i of groups[k]) clues[i] = 0;
  return removed;
}

// Deductive Kurodoko solver.
//
// Every deduction is sound, so if the solver fills the whole grid the puzzle
// has exactly one solution. The level caps which techniques it may use, which
// is how the generator grades difficulty:
//
//   BASIC   - shaded cells force their neighbours unshaded; each number's
//             possible view lengths in the four directions are intersected.
//   CONNECT - plus connectivity: a cell whose shading would split the
//             unshaded cells must stay unshaded (its open neighbours would
//             all have to be unshaded, on different sides of the cut).
//   TRIAL   - plus one-step contradiction: assume a cell, propagate a bounded
//             number of steps, and if that breaks a rule the cell takes the
//             other value. Tried on every unknown cell, or with zoneOnly set,
//             just on the cells in the zone.
//
// All changes go on a trail, so callers can mark() a state, add clues or make
// assumptions, and rollback() to the mark. The generator relies on this to
// test clue removals incrementally.

import { neighbourTable } from './grid.js';

export const UNKNOWN = -1;
export const WHITE = 0;
export const BLACK = 1;

export const BASIC = 1;
export const CONNECT = 2;
export const TRIAL = 3;

/** Default number of clue evaluations an assumption may follow (see trialBudget). */
export const TRIAL_BUDGET = 60;
/** A short what-if: one whose contradiction shows within a few steps. */
export const SHORT_TRIAL_BUDGET = 6;

// Ring of the 8 surrounding cells, clockwise from north.
const RING_DR = [-1, -1, 0, 1, 1, 1, 0, -1];
const RING_DC = [0, 1, 1, 1, 0, -1, -1, -1];

/** Bit set of a + b for a in x, b in y (32-bit masks). */
function sumset(x, y) {
  let r = 0;
  while (x) {
    const low = x & -x;
    r |= y << (31 - Math.clz32(low));
    x ^= low;
  }
  return r;
}

/** Bit set of n1 - a for a in x. */
function reverse(x, n1) {
  let r = 0;
  while (x) {
    const low = x & -x;
    r |= 1 << (n1 - (31 - Math.clz32(low)));
    x ^= low;
  }
  return r;
}

/** Bit set of a such that a + b is in v for some b in y. */
function shrink(v, y) {
  let r = 0;
  while (y) {
    const low = y & -y;
    r |= v >>> (31 - Math.clz32(low));
    y ^= low;
  }
  return r;
}

export class Solver {
  constructor(w, h) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.n = n;
    this.nb = neighbourTable(w, h);
    this.clue = new Int16Array(n);
    this.st = new Int8Array(n);
    this.blackNb = new Uint8Array(n);
    // Shaded cells among the 8 surrounding cells, plus 1 on the grid edge.
    this.blocked8 = new Uint8Array(n);
    this.edge = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / w);
      const c = i % w;
      this.edge[i] = r === 0 || c === 0 || r === h - 1 || c === w - 1 ? 1 : 0;
    }
    this.done = new Uint8Array(n);
    this.clueStack = [];
    this.unknown = n;

    // Cells the caller cares about (default: all) and how many are unknown.
    this.target = new Uint8Array(n).fill(1);
    this.targetUnknown = n;

    // Cells whose value changed and still need processing.
    this.cellQ = new Int32Array(n);
    this.qh = 0;
    this.qt = 0;
    // Clues to re-evaluate (circular; a clue is queued at most once).
    this.clueQ = new Int32Array(n);
    this.dirty = new Uint8Array(n);
    this.ch = 0;
    this.ct = 0;
    this.clueQLen = 0;
    this.budget = Infinity;

    // Undo trail: every determined cell, and every clue marked done.
    this.trail = new Int32Array(n);
    this.tl = 0;
    this.doneTrail = new Int32Array(n);
    this.dtl = 0;
    // Trail length when connect() last found nothing (-1: not since load).
    this.fixAt = -1;
    // Trail length when each clue first deduced something (n+1 = never).
    this.firstUse = new Int32Array(n);

    // How far a what-if may be followed: clue evaluations before giving up.
    this.trialBudget = TRIAL_BUDGET;

    // Cells to try by contradiction when zoneOnly is set. If trialHits is an
    // array, cells settled by contradiction are appended to it.
    this.zoneOnly = false;
    this.trialHits = null;
    this.zone = new Int32Array(n);
    this.inZone = new Uint8Array(n);
    this.zoneLen = 0;

    // Scratch space for clue evaluation: S slots per direction.
    const S = Math.max(w, h) + 1;
    this.S = S;
    this.F = new Uint8Array(4 * S);
    this.P = new Int32Array(4 * S + 1);
    this.maxK = new Int32Array(4);
    const T = w + h + 1;
    this.VS = new Uint8Array(T);
    this.HS = new Uint8Array(T);
    this.Vok = new Uint8Array(T);
    this.Hok = new Uint8Array(T);

    // Connectivity: shaded cells grouped by 8-adjacency, with the area outside
    // the grid as one extra member (index n). Union-find with undo (no path
    // compression); umark[k] is the union count before trail entry k.
    this.dsuParent = new Int32Array(n + 1);
    this.dsuSize = new Int32Array(n + 1);
    this.unions = new Int32Array(n + 1);
    this.usp = 0;
    this.umark = new Int32Array(n);
    this.ringComp = new Int32Array(8);
    this.runRoots = new Int32Array(4);
    this.runOrth = new Uint8Array(4);

    this.stats = { connect: 0, trial: 0 };
  }

  /** Load a full clue array (0 = no clue) and reset the grid. */
  load(clues) {
    const { n } = this;
    this.clue.fill(0);
    this.clueStack.length = 0;
    this.st.fill(UNKNOWN);
    this.blackNb.fill(0);
    this.blocked8.set(this.edge);
    for (let i = 0; i <= n; i++) {
      this.dsuParent[i] = i;
      this.dsuSize[i] = 1;
    }
    this.usp = 0;
    this.done.fill(0);
    this.dirty.fill(0);
    this.target.fill(1);
    this.unknown = this.targetUnknown = n;
    this.tl = this.dtl = 0;
    this.fixAt = -1;
    this.firstUse.fill(n + 1);
    this.inZone.fill(0);
    this.zoneLen = 0;
    this.qh = this.qt = 0;
    this.ch = this.ct = this.clueQLen = 0;
    this.stats = { connect: 0, trial: 0 };
    for (let i = 0; i < n; i++) if (clues[i]) this.addClue(i, clues[i]);
    return this;
  }

  /** Choose which cells targetUnknown counts. */
  setTarget(mask) {
    this.target.set(mask);
    let u = 0;
    for (let i = 0; i < this.n; i++) if (mask[i] && this.st[i] === UNKNOWN) u++;
    this.targetUnknown = u;
  }

  /** Add one clue to the current state (deductions so far stay valid). */
  addClue(i, value) {
    this.clue[i] = value;
    this.clueStack.push(i);
    this.queueClue(i);
    return this.set(i, WHITE);
  }

  addZone(i) {
    if (this.inZone[i]) return;
    this.inZone[i] = 1;
    this.zone[this.zoneLen++] = i;
  }

  /** Drop zone cells added after the zone had length len. */
  truncateZone(len) {
    while (this.zoneLen > len) this.inZone[this.zone[--this.zoneLen]] = 0;
  }

  mark() {
    return { tl: this.tl, dtl: this.dtl, cs: this.clueStack.length, fixAt: this.fixAt };
  }

  /** Undo everything (cells, done flags, added clues) since mark m. */
  rollback(m) {
    const { st, done, trail, doneTrail, target, nb, blackNb, umark, unions, dsuParent, dsuSize } = this;
    for (let k = this.tl - 1; k >= m.tl; k--) {
      const i = trail[k];
      while (this.usp > umark[k]) {
        const child = unions[--this.usp];
        dsuSize[dsuParent[child]] -= dsuSize[child];
        dsuParent[child] = child;
      }
      if (st[i] === BLACK) {
        for (let d = 0; d < 4; d++) {
          const j = nb[4 * i + d];
          if (j >= 0) blackNb[j]--;
        }
        this.ring8(i, -1);
      }
      st[i] = UNKNOWN;
      if (target[i]) this.targetUnknown++;
    }
    this.unknown += this.tl - m.tl;
    this.tl = m.tl;
    for (let k = this.dtl - 1; k >= m.dtl; k--) done[doneTrail[k]] = 0;
    this.dtl = m.dtl;
    this.fixAt = m.fixAt;
    while (this.clueStack.length > m.cs) this.clue[this.clueStack.pop()] = 0;
    this.clearQueues();
  }

  /** Run deductions up to the given level. Returns true when fully solved. */
  solve(level = CONNECT) {
    this.contradiction = !this.run(level);
    return !this.contradiction && this.unknown === 0;
  }

  /** Deduce until stuck. Returns false on contradiction. */
  run(level) {
    for (;;) {
      if (!this.propagate()) return false;
      // The shading is unchanged since connect() last found nothing if the
      // trail still has the same length.
      if ((level >= CONNECT || this.unknown === 0) && this.fixAt !== this.tl) {
        const r = this.connect();
        if (r < 0) return false;
        if (r > 0) {
          this.stats.connect += r;
          continue;
        }
        this.fixAt = this.tl;
      }
      if (this.unknown === 0) return true;
      if (level >= TRIAL) {
        const r = this.trial();
        if (r < 0) return false;
        if (r > 0) {
          this.stats.trial += r;
          continue;
        }
      }
      return true;
    }
  }

  set(i, v) {
    const s = this.st[i];
    if (s === v) return true;
    if (s !== UNKNOWN) return false;
    this.umark[this.tl] = this.usp;
    if (v === BLACK) {
      // Shading a cut cell would disconnect the unshaded cells.
      if (this.clue[i] || this.isCut(i)) return false;
      const { nb, blackNb, w, h } = this;
      for (let d = 0; d < 4; d++) {
        const j = nb[4 * i + d];
        if (j >= 0) blackNb[j]++;
      }
      const r = Math.floor(i / w);
      const c = i % w;
      for (let k = 0; k < 8; k++) {
        const rr = r + RING_DR[k];
        const cc = c + RING_DC[k];
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) this.union(i, this.n);
        else if (this.st[rr * w + cc] === BLACK) this.union(i, rr * w + cc);
      }
      this.ring8(i, 1);
    }
    this.st[i] = v;
    this.unknown--;
    if (this.target[i]) this.targetUnknown--;
    this.trail[this.tl++] = i;
    if (this.qh === this.qt) this.qh = this.qt = 0;
    this.cellQ[this.qt++] = i;
    return true;
  }

  queueClue(p) {
    if (this.dirty[p] || this.done[p]) return;
    this.dirty[p] = 1;
    this.clueQ[this.ct] = p;
    this.ct = (this.ct + 1) % this.n;
    this.clueQLen++;
  }

  clearQueues() {
    this.qh = this.qt = 0;
    while (this.clueQLen > 0) {
      this.dirty[this.clueQ[this.ch]] = 0;
      this.ch = (this.ch + 1) % this.n;
      this.clueQLen--;
    }
  }

  /** Basic deductions to a fixpoint (or until the budget runs out). */
  propagate() {
    const { st, nb, clue } = this;
    for (;;) {
      if (this.qh < this.qt) {
        const i = this.cellQ[this.qh++];
        if (st[i] === BLACK) {
          for (let d = 0; d < 4; d++) {
            const j = nb[4 * i + d];
            if (j >= 0 && !this.set(j, WHITE)) return this.fail();
          }
        }
        // Re-evaluate the clues that can see i: walk out to the first shaded cell.
        for (let d = 0; d < 4; d++) {
          let j = nb[4 * i + d];
          for (let dist = 1; j >= 0; dist++) {
            if (clue[j] && dist <= clue[j]) this.queueClue(j);
            if (st[j] === BLACK) break;
            j = nb[4 * j + d];
          }
        }
        continue;
      }
      if (this.clueQLen > 0) {
        if (this.budget-- <= 0) {
          this.clearQueues();
          return true;
        }
        const p = this.clueQ[this.ch];
        this.ch = (this.ch + 1) % this.n;
        this.clueQLen--;
        this.dirty[p] = 0;
        if (!this.done[p] && !this.evalClue(p)) return this.fail();
        continue;
      }
      return true;
    }
  }

  fail() {
    this.clearQueues();
    return false;
  }

  /**
   * Intersect all view-length combinations of the clue at p. For clues up to
   * 31 each direction's possible lengths fit in a 32-bit mask; larger clues
   * take the array version below.
   */
  evalClue(p) {
    const n1 = this.clue[p] - 1;
    if (n1 > 30) return this.evalClueWide(p);
    const { st, nb, clue, blackNb, P, S } = this;
    const tl0 = this.tl;

    // f[d] bit a: the view in direction d can have length a (cells 1..a
    // unshaded and the next one the edge, shaded, or able to be shaded).
    let f0 = 0;
    let f1 = 0;
    let f2 = 0;
    let f3 = 0;
    for (let d = 0; d < 4; d++) {
      const base = d * S;
      let pos = p;
      let m = 0;
      for (let k = 0; ; k++) {
        const nx = nb[4 * pos + d];
        P[base + k + 1] = nx;
        if (nx < 0) { m |= 1 << k; break; }
        const s = st[nx];
        if (s === BLACK) { m |= 1 << k; break; }
        if (s === UNKNOWN && !clue[nx] && blackNb[nx] === 0) m |= 1 << k;
        if (k === n1) break;
        pos = nx;
      }
      if (d === 0) f0 = m;
      else if (d === 1) f1 = m;
      else if (d === 2) f2 = m;
      else f3 = m;
    }

    const lim = (1 << (n1 + 1)) - 1;
    const vs = sumset(f0, f1) & lim;
    const hs = sumset(f2, f3) & lim;
    const vok = vs & reverse(hs, n1);
    if (!vok) return false;
    const hok = reverse(vok, n1);
    const g0 = f0 & shrink(vok, f1);
    const g1 = f1 & shrink(vok, f0);
    const g2 = f2 & shrink(hok, f3);
    const g3 = f3 & shrink(hok, f2);

    let allSingle = true;
    for (let d = 0; d < 4; d++) {
      const g = d === 0 ? g0 : d === 1 ? g1 : d === 2 ? g2 : g3;
      if (!g) return false;
      const base = d * S;
      const min = 31 - Math.clz32(g & -g);
      for (let k = 1; k <= min; k++) {
        if (!this.set(P[base + k], WHITE)) return false;
      }
      if ((g & (g - 1)) === 0) {
        const end = P[base + min + 1];
        if (end >= 0 && !this.set(end, BLACK)) return false;
      } else {
        allSingle = false;
      }
    }
    if (allSingle) {
      this.done[p] = 1;
      this.doneTrail[this.dtl++] = p;
    }
    if (this.tl > tl0 && this.firstUse[p] > tl0) this.firstUse[p] = tl0;
    return true;
  }

  evalClueWide(p) {
    const { st, nb, clue, blackNb, F, P, S, maxK, VS, HS, Vok, Hok } = this;
    const n1 = clue[p] - 1;

    // F[d*S + a] = 1 if the view in direction d can have length a: cells
    // 1..a unshaded and the next one the edge, shaded, or able to be shaded.
    for (let d = 0; d < 4; d++) {
      const base = d * S;
      let pos = p;
      let k = 0;
      for (;;) {
        const nx = nb[4 * pos + d];
        P[base + k + 1] = nx;
        if (nx < 0) { F[base + k] = 1; break; }
        const s = st[nx];
        if (s === BLACK) { F[base + k] = 1; break; }
        F[base + k] = s === UNKNOWN && !clue[nx] && blackNb[nx] === 0 ? 1 : 0;
        if (k === n1) break;
        k++;
        pos = nx;
      }
      maxK[d] = k;
    }

    // Sum sets of the vertical (up+down) and horizontal (left+right) pairs.
    VS.fill(0, 0, n1 + 1);
    HS.fill(0, 0, n1 + 1);
    for (let a = 0; a <= maxK[0]; a++) {
      if (!F[a]) continue;
      for (let b = 0; b <= maxK[1] && a + b <= n1; b++) if (F[S + b]) VS[a + b] = 1;
    }
    for (let a = 0; a <= maxK[2]; a++) {
      if (!F[2 * S + a]) continue;
      for (let b = 0; b <= maxK[3] && a + b <= n1; b++) if (F[3 * S + b]) HS[a + b] = 1;
    }
    let any = false;
    for (let v = 0; v <= n1; v++) {
      Vok[v] = VS[v] && HS[n1 - v] ? 1 : 0;
      Hok[n1 - v] = Vok[v];
      if (Vok[v]) any = true;
    }
    if (!any) return false;

    // Keep only lengths that take part in some full combination, then deduce.
    const tl0 = this.tl;
    let allSingle = true;
    for (let d = 0; d < 4; d++) {
      const base = d * S;
      const ob = (d ^ 1) * S;
      const om = maxK[d ^ 1];
      const ok = d < 2 ? Vok : Hok;
      let min = -1;
      let count = 0;
      let only = -1;
      for (let a = 0; a <= maxK[d]; a++) {
        if (!F[base + a]) continue;
        let good = false;
        for (let b = 0; b <= om && a + b <= n1; b++) {
          if (F[ob + b] && ok[a + b]) { good = true; break; }
        }
        if (!good) continue;
        if (min < 0) min = a;
        count++;
        only = a;
      }
      if (min < 0) return false;
      for (let k = 1; k <= min; k++) {
        if (!this.set(P[base + k], WHITE)) return false;
      }
      if (count === 1) {
        const end = P[base + only + 1];
        if (end >= 0 && !this.set(end, BLACK)) return false;
      } else {
        allSingle = false;
      }
    }
    if (allSingle) {
      this.done[p] = 1;
      this.doneTrail[this.dtl++] = p;
    }
    if (this.tl > tl0 && this.firstUse[p] > tl0) this.firstUse[p] = tl0;
    return true;
  }

  /** Add delta to blocked8 of the cells around i. */
  ring8(i, delta) {
    const { w, h, blocked8 } = this;
    const r = Math.floor(i / w);
    const c = i % w;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(h - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(w - 1, c + 1); cc++) {
        if (rr !== r || cc !== c) blocked8[rr * w + cc] += delta;
      }
    }
  }

  find(x) {
    const p = this.dsuParent;
    while (p[x] !== x) x = p[x];
    return x;
  }

  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.dsuSize[ra] < this.dsuSize[rb]) { const t = ra; ra = rb; rb = t; }
    this.dsuParent[rb] = ra;
    this.dsuSize[ra] += this.dsuSize[rb];
    this.unions[this.usp++] = rb;
  }

  /**
   * Would shading cell i disconnect the unshaded (and unknown) cells? Around
   * i, shaded cells (and the outside of the grid) form runs separated by
   * runs of open cells. Shading i cuts two of its side neighbours apart
   * exactly when two shaded runs already belong to the same 8-connected
   * shaded group and both arcs between them contain a side neighbour: the
   * new shaded cell closes a loop with one neighbour on each side.
   */
  isCut(i) {
    if (this.blocked8[i] < 2) return false;
    const { w, h, n, st, ringComp, runRoots, runOrth } = this;
    const r = Math.floor(i / w);
    const c = i % w;
    let start = -1;
    for (let k = 0; k < 8; k++) {
      const rr = r + RING_DR[k];
      const cc = c + RING_DC[k];
      let x = -1;
      if (rr < 0 || rr >= h || cc < 0 || cc >= w) x = n;
      else if (st[rr * w + cc] === BLACK) x = rr * w + cc;
      ringComp[k] = x;
    }
    // Start at the first shaded slot that follows an open one.
    for (let k = 0; k < 8; k++) {
      if (ringComp[k] >= 0 && ringComp[(k + 7) & 7] < 0) { start = k; break; }
    }
    if (start < 0) return false;
    // runRoots[q]: group of the q-th shaded run; runOrth[q]: whether the open
    // run after it contains a side neighbour (even slot).
    let runs = 0;
    for (let s = 0; s < 8; s++) {
      const k = (start + s) & 7;
      const x = ringComp[k];
      if (x >= 0) {
        if (ringComp[(k + 7) & 7] < 0) {
          runRoots[runs] = this.find(x);
          runOrth[runs++] = 0;
        }
      } else if ((k & 1) === 0) {
        runOrth[runs - 1] = 1;
      }
    }
    for (let a = 0; a < runs; a++) {
      for (let b = a + 1; b < runs; b++) {
        if (runRoots[a] !== runRoots[b]) continue;
        let inside = false;
        let outside = false;
        for (let q = 0; q < runs; q++) {
          if (!runOrth[q]) continue;
          if (q >= a && q < b) inside = true;
          else outside = true;
        }
        if (inside && outside) return true;
      }
    }
    return false;
  }

  /** Unknown cells that are cuts must be unshaded. Returns the number deduced. */
  connect() {
    const { n, st } = this;
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (st[i] === UNKNOWN && this.isCut(i)) {
        if (!this.set(i, WHITE)) return -1;
        changed++;
      }
    }
    return changed;
  }

  /** Does assuming cell i = v lead to a contradiction? State is unchanged afterwards. */
  refutes(i, v) {
    const m = this.mark();
    this.budget = this.trialBudget;
    const ok = this.set(i, v) && this.propagate();
    this.budget = Infinity;
    this.rollback(m);
    return !ok;
  }

  /** One pass of one-step contradictions. Returns cells deduced, or -1 on contradiction. */
  trial() {
    const { st } = this;
    const cells = this.zoneOnly ? this.zone.subarray(0, this.zoneLen) : null;
    const count = cells ? cells.length : this.n;
    let found = 0;
    for (let k = 0; k < count; k++) {
      const i = cells ? cells[k] : k;
      if (st[i] !== UNKNOWN) continue;
      let v = -1;
      if (this.refutes(i, BLACK)) v = WHITE;
      else if (this.refutes(i, WHITE)) v = BLACK;
      if (v < 0) continue;
      if (!this.set(i, v) || !this.propagate()) return -1;
      if (this.trialHits) this.trialHits.push(i);
      found++;
    }
    return found;
  }

  /** Count solutions up to limit by search (for tests and small grids). */
  countSolutions(limit = 2) {
    if (!this.run(CONNECT)) return 0;
    if (this.unknown === 0) return 1;
    let i = 0;
    while (this.st[i] !== UNKNOWN) i++;
    let total = 0;
    for (const v of [BLACK, WHITE]) {
      const m = this.mark();
      if (this.set(i, v)) total += this.countSolutions(limit - total);
      this.rollback(m);
      if (total >= limit) break;
    }
    return total;
  }

  /** Current grid as an array: 1 shaded, 0 unshaded, -1 unknown. */
  grid() {
    return Array.from(this.st);
  }
}

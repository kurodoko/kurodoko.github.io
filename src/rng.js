// Deterministic pseudo-random numbers.
//
// Everything here uses 32-bit integer arithmetic only, so a given seed yields
// the same sequence in every JavaScript engine. Never use Math.random() in the
// generator: puzzle URLs rely on (width, height, seed, difficulty) alone.

/** Hash any list of values into four 32-bit words (cyrb128). */
export function hashParts(...parts) {
  const str = parts.map(String).join('␟');
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Small fast counter PRNG (sfc32), seeded from hashParts(...). */
export class Rng {
  constructor(...parts) {
    [this.a, this.b, this.c, this.d] = hashParts(...parts);
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Next unsigned 32-bit integer. */
  next() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  float() {
    return this.next() / 4294967296;
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.float() * n);
  }

  chance(p) {
    return this.float() < p;
  }

  pick(arr) {
    return arr[this.int(arr.length)];
  }

  /** Index chosen with probability proportional to (non-negative) weights. */
  weighted(weights) {
    let total = 0;
    for (const w of weights) total += w;
    let x = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x < 0) return i;
    }
    return weights.length - 1;
  }

  /** Fisher–Yates shuffle in place; returns the array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** Independent child stream, so adding draws in one phase never shifts another. */
  fork(label) {
    return new Rng(this.a, this.b, this.c, this.d, label);
  }
}

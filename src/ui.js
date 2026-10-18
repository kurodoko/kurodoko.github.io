// SVG board: draws a Game and turns clicks into moves.
//
// Elements are created once per puzzle and only re-classed when a cell's
// look changes, so a 60×60 board stays responsive.
//
// A move happens on release, and only if the pointer stayed on the cell it
// pressed: dragging never marks cells (on touch screens it scrolls the page).
// Zooming is left to the browser (pinch, or Ctrl/⌘ + and −); the board is
// only sized to fit the window by fit().

import { columnName } from './grid.js';
import { FILLED, DOT, AUTO, CLUE_DONE, CLUE_ERROR } from './game.js';

const NS = 'http://www.w3.org/2000/svg';
/** Cell size in SVG units; the board is scaled as a whole. */
const U = 40;
const MARGIN_LEFT = 1.5 * U;
const MARGIN_TOP = 1.05 * U;
const PAD = 0.3 * U;
/** Pointer travel (px) that turns a press into a scroll instead of a click. */
const CLICK_SLOP = 10;

/** '#rrggbb' → [r, g, b]. */
function hexColor(s) {
  const m = /#([0-9a-f]{6})/i.exec(s);
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Hue (degrees), saturation and lightness (0–1) → [r, g, b]. */
function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** [r, g, b] → [hue (degrees), saturation, lightness (0–1)]. */
function toHsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const smooth = (a, b, t) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

export class Board {
  constructor(svg, { onCommit = () => {}, onHover = () => {} } = {}) {
    this.svg = svg;
    this.onCommit = onCommit;
    this.onHover = onHover;
    this.game = null;
    this.scale = 1;
    this.press = null;
    this.touchPointers = new Set();
    this.hover = -1;

    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.pointerUp(e));
    svg.addEventListener('pointercancel', (e) => this.pointerEnd(e));
    svg.addEventListener('pointerleave', () => this.setHover(-1));
  }

  get width() {
    return MARGIN_LEFT + this.game.w * U + PAD;
  }

  get height() {
    return MARGIN_TOP + this.game.h * U + PAD;
  }

  setGame(game) {
    this.stopCelebration();
    this.game = game;
    const { w, h } = game;
    const svg = this.svg;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    svg.setAttribute('aria-label', `Kurodoko board, ${w} by ${h}`);

    el('rect', { x: MARGIN_LEFT, y: MARGIN_TOP, width: w * U, height: h * U, class: 'board-bg' }, svg);
    const cellLayer = el('g', {}, svg);
    const lineLayer = el('g', {}, svg);
    const markLayer = el('g', {}, svg);
    this.hintLayer = el('g', {}, svg);
    const labelLayer = el('g', { class: 'labels' }, svg);
    this.labelLayer = labelLayer;

    this.rects = [];
    this.dots = [];
    this.texts = [];
    this.look = new Int16Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
      const x = MARGIN_LEFT + (i % w) * U;
      const y = MARGIN_TOP + Math.floor(i / w) * U;
      this.rects.push(el('rect', { x, y, width: U, height: U, class: 'cell' }, cellLayer));
      if (game.clues[i]) {
        const t = el('text', { x: x + U / 2, y: y + U / 2, class: 'clue' }, markLayer);
        t.textContent = game.clues[i];
        if (game.clues[i] >= 100) t.style.fontSize = '16px';
        this.texts.push(t);
        this.dots.push(null);
      } else {
        this.texts.push(null);
        this.dots.push(el('circle', { cx: x + U / 2, cy: y + U / 2, r: 0, class: 'dot' }, markLayer));
      }
    }

    // Every 4th line is heavier, to help counting.
    const lines = ['', ''];
    for (let c = 1; c < w; c++) lines[c % 4 === 0 ? 1 : 0] += `M${MARGIN_LEFT + c * U} ${MARGIN_TOP}v${h * U}`;
    for (let r = 1; r < h; r++) lines[r % 4 === 0 ? 1 : 0] += `M${MARGIN_LEFT} ${MARGIN_TOP + r * U}h${w * U}`;
    el('path', { d: lines[0], class: 'grid-line' }, lineLayer);
    el('path', { d: lines[1], class: 'grid-line major' }, lineLayer);
    el('rect', { x: MARGIN_LEFT, y: MARGIN_TOP, width: w * U, height: h * U, class: 'grid-border' }, lineLayer);

    this.colLabels = [];
    this.rowLabels = [];
    for (let c = 0; c < w; c++) {
      const t = el('text', { x: MARGIN_LEFT + (c + 0.5) * U, y: MARGIN_TOP - 0.35 * U, class: 'col-label' }, labelLayer);
      t.textContent = columnName(c);
      this.colLabels.push(t);
    }
    for (let r = 0; r < h; r++) {
      const t = el('text', { x: MARGIN_LEFT - 0.3 * U, y: MARGIN_TOP + (r + 0.5) * U, class: 'row-label' }, labelLayer);
      t.textContent = r + 1;
      this.rowLabels.push(t);
    }
    this.hover = -1;
    // Zero size until fit(): drawn at the previous scale a new board could
    // overflow, and phones then widen the page, which spoils the fit.
    svg.setAttribute('width', 0);
    svg.setAttribute('height', 0);
    this.render();
  }

  /** Redraw changed cells. Returns the analysis used. */
  render() {
    const game = this.game;
    const a = game.analyze();
    const { cells, clues } = game;
    for (let i = 0; i < game.n; i++) {
      const v = cells[i];
      let look;
      if (clues[i]) look = 16 + a.clueState[i] * 2 + a.isolated[i];
      else look = v * 4 + a.adjacent[i] * 2 + a.isolated[i];
      if (look === this.look[i]) continue;
      this.look[i] = look;
      // Numbers and dots share the pale "unshaded" background.
      let cls = 'cell';
      if (v === FILLED) cls += a.adjacent[i] ? ' filled error' : ' filled';
      else if (a.isolated[i]) cls += ' isolated';
      else if (clues[i] || v === DOT || v === AUTO) cls += ' dotted';
      this.rects[i].setAttribute('class', cls);
      if (clues[i]) {
        const s = a.clueState[i];
        this.texts[i].setAttribute('class', s === CLUE_ERROR ? 'clue error' : s === CLUE_DONE ? 'clue done' : 'clue');
      } else {
        const dot = this.dots[i];
        dot.setAttribute('r', v === DOT ? 0.12 * U : v === AUTO ? 0.08 * U : 0);
        dot.setAttribute('class', v === AUTO ? 'dot auto' : 'dot');
      }
    }
    this.svg.classList.toggle('solved', a.solved);
    if (!a.solved) this.stopCelebration();
    this.analysis = a;
    return a;
  }

  /**
   * Just solved: rings ripple out from the last move. Where the first ring
   * passes, shaded cells and dots leave their usual colours for a muted
   * green; the rings that follow carry bands of hue (yellow-green to blue)
   * and light that grow stronger for a few seconds. A last ring then leaves
   * everything on the solved greens. With reduced motion, a short fade.
   */
  celebrate() {
    this.stopCelebration();
    const { w, h, n, cells, lastMove } = this.game;
    const style = getComputedStyle(this.svg);
    const color = (name) => hexColor(style.getPropertyValue(name));
    const kinds = {
      filled: { from: color('--filled'), to: color('--ok') },
      dot: { from: color('--dot'), to: color('--ok-dot') },
    };
    for (const k of Object.values(kinds)) [k.hue, k.sat, k.light] = toHsl(k.to);
    const r0 = lastMove >= 0 ? Math.floor(lastMove / w) : (h - 1) / 2;
    const c0 = lastMove >= 0 ? lastMove % w : (w - 1) / 2;
    const far = Math.max(1, ...[[0, 0], [0, w - 1], [h - 1, 0], [h - 1, w - 1]].map(([r, c]) => Math.hypot(r - r0, c - c0)));
    const items = [];
    for (let i = 0; i < n; i++) {
      const kind = cells[i] === FILLED ? kinds.filled : (cells[i] === DOT || cells[i] === AUTO) && this.dots[i] ? kinds.dot : null;
      if (!kind) continue;
      // u: distance from the last move, 0 there and 1 at the farthest corner.
      const u = Math.hypot(Math.floor(i / w) - r0, (i % w) - c0) / far;
      const scatter = ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296) * 1.2;
      items.push({ node: kind === kinds.filled ? this.rects[i] : this.dots[i], kind, u, scatter });
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduce ? 800 : 6500;
    const start = performance.now();
    this.celebrating = items;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      for (const { node, kind, u, scatter } of items) {
        let rgb;
        if (reduce) {
          rgb = mix(kind.from, kind.to, smooth(0, 1, t));
        } else {
          const arrive = smooth(0.15 * u, 0.15 * u + 0.1, t);
          const strength = smooth(0.1 * u, 0.1 * u + 0.45, t);
          const settle = smooth(0.72 + 0.18 * u, 0.82 + 0.18 * u, t);
          // Rings: two across the board at a time, one passing every second.
          const wave = 2 * Math.PI * (2 * u - 7 * t);
          const hue = kind.hue + 10 + 70 * strength * Math.sin(wave + scatter);
          const light = kind.light + 0.07 * strength * Math.cos(wave);
          rgb = mix(mix(kind.from, hsl(hue, kind.sat * 0.75, light), arrive), kind.to, settle);
        }
        node.style.fill = `rgb(${rgb.map(Math.round).join(',')})`;
      }
      if (t < 1) this.anim = requestAnimationFrame(frame);
      else this.stopCelebration();
    };
    this.anim = requestAnimationFrame(frame);
  }

  /** End the solve animation; the stylesheet's colours take over again. */
  stopCelebration() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
    for (const { node } of this.celebrating || []) node.style.fill = '';
    this.celebrating = null;
  }

  /**
   * Outline cells in pink for a hint: { cell, kind } with kind 'number' or
   * 'mistake' for that cell, 'area' for the 3×3 block around it.
   */
  setHint(items) {
    if (!this.game) return;
    this.hintLayer.replaceChildren();
    const { w, h } = this.game;
    const inset = 0.06 * U;
    for (const { cell, kind } of items) {
      const r = Math.floor(cell / w);
      const c = cell % w;
      const k = kind === 'area' ? 1 : 0;
      const r0 = Math.max(0, r - k);
      const c0 = Math.max(0, c - k);
      const rows = Math.min(h - 1, r + k) - r0 + 1;
      const cols = Math.min(w - 1, c + k) - c0 + 1;
      el('rect', {
        x: MARGIN_LEFT + c0 * U + inset,
        y: MARGIN_TOP + r0 * U + inset,
        width: cols * U - 2 * inset,
        height: rows * U - 2 * inset,
        rx: 0.12 * U,
        class: `hint-mark ${kind}`,
      }, this.hintLayer);
    }
  }

  // --- size -----------------------------------------------------------------

  /** Size the board to fit inside maxWidth × maxHeight (cells at most 48px). */
  fit(maxWidth, maxHeight) {
    this.scale = Math.min(maxWidth / this.width, maxHeight / this.height, 48 / U);
    this.applyScale();
  }

  applyScale() {
    if (!this.game) return;
    // Round down so the board never spills over its container.
    this.svg.setAttribute('width', Math.floor(this.width * this.scale));
    this.svg.setAttribute('height', Math.floor(this.height * this.scale));
    // Lets the page centre things over the grid rather than the whole board.
    this.svg.parentElement.style.setProperty('--grid-shift', `${(MARGIN_LEFT - PAD) * this.scale}px`);
    // Keep coordinates at least ~8px on screen, within what fits a cell.
    this.labelLayer.style.fontSize = `${Math.min(0.5 * U, Math.max(0.35 * U, 8 / this.scale))}px`;
  }

  // --- input ----------------------------------------------------------------

  cellAt(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return -1;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const c = Math.floor((p.x - MARGIN_LEFT) / U);
    const r = Math.floor((p.y - MARGIN_TOP) / U);
    if (c < 0 || r < 0 || c >= this.game.w || r >= this.game.h) return -1;
    return r * this.game.w + c;
  }

  pointerDown(e) {
    if (e.pointerType === 'touch') {
      this.touchPointers.add(e.pointerId);
      // A second finger means a pinch, not a tap.
      if (this.touchPointers.size > 1) {
        this.press = null;
        return;
      }
    }
    if (!this.game || (e.button !== 0 && e.button !== 2)) return;
    const i = this.cellAt(e);
    if (i < 0) return;
    // Mouse: avoid text selection. Touch: leave the browser free to scroll and zoom.
    if (e.pointerType === 'mouse') e.preventDefault();
    this.press = { id: e.pointerId, cell: i, x: e.clientX, y: e.clientY, reverse: e.button === 2 || e.shiftKey };
  }

  pointerMove(e) {
    if (!this.game) return;
    const p = this.press;
    if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) this.press = null;
    if (e.pointerType === 'mouse') this.setHover(this.cellAt(e));
  }

  pointerUp(e) {
    const p = this.press;
    this.pointerEnd(e);
    if (!p || p.id !== e.pointerId || this.cellAt(e) !== p.cell) return;
    if (this.game.click(p.cell, p.reverse)) {
      this.render();
      this.onCommit();
    }
  }

  pointerEnd(e) {
    this.touchPointers.delete(e.pointerId);
    if (this.press && this.press.id === e.pointerId) this.press = null;
  }

  /** Highlight the margin coordinates of the cell under the pointer. */
  setHover(i) {
    if (i === this.hover) return;
    const w = this.game.w;
    if (this.hover >= 0) {
      this.colLabels[this.hover % w].classList.remove('hl');
      this.rowLabels[Math.floor(this.hover / w)].classList.remove('hl');
    }
    this.hover = i;
    if (i >= 0) {
      this.colLabels[i % w].classList.add('hl');
      this.rowLabels[Math.floor(i / w)].classList.add('hl');
    }
    this.onHover(i);
  }
}

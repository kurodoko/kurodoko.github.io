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

/** Display an SVG element, or take it out of the rendering altogether. */
function show(node, visible) {
  if (visible) node.removeAttribute('display');
  else node.setAttribute('display', 'none');
}

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

/** Rows per band of the board (see setGame). */
const BAND = 8;

export class Board {
  constructor(svg, { onCommit = () => {}, onHover = () => {} } = {}) {
    // The base SVG (background and labels) sits in a container that also
    // holds the board's other layers; it sets the size, the layers follow.
    this.svg = svg;
    this.root = svg.parentElement;
    this.onCommit = onCommit;
    this.onHover = onHover;
    this.game = null;
    this.scale = 1;
    // Pinch zoom of the page (see setZoom).
    this.zoom = 1;
    this.press = null;
    this.touchPointers = new Set();
    this.hover = -1;

    const root = this.root;
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('pointerdown', (e) => this.pointerDown(e));
    root.addEventListener('pointermove', (e) => this.pointerMove(e));
    root.addEventListener('pointerup', (e) => this.pointerUp(e));
    root.addEventListener('pointercancel', (e) => this.pointerEnd(e));
    root.addEventListener('pointerleave', () => this.setHover(-1));
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
    for (const node of [...this.root.children]) if (node !== svg) node.remove();
    svg.replaceChildren();
    const viewBox = `0 0 ${this.width} ${this.height}`;
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-label', `Kurodoko board, ${w} by ${h}`);

    // The board is a stack of SVG layers of the same size, from the bottom:
    // background and labels (the base SVG), cell fills, grid lines, dots and
    // numbers, then hints and the hit area. Fills and marks come in bands of
    // BAND rows, each its own SVG: the browser repaints only the bands a move
    // changes and reuses the rest, which on a 60×60 board on a slow tablet
    // is the difference between a quick and a sluggish tap.
    const layer = (cls) => {
      const s = el('svg', { viewBox, class: `layer ${cls}`, 'aria-hidden': 'true' });
      this.root.appendChild(s);
      return s;
    };
    el('rect', { x: MARGIN_LEFT, y: MARGIN_TOP, width: w * U, height: h * U, class: 'board-bg' }, svg);
    const labelLayer = el('g', { class: 'labels' }, svg);
    this.labelLayer = labelLayer;
    const bands = Math.ceil(h / BAND);
    const fillBands = Array.from({ length: bands }, () => layer('fills'));
    const lineLayer = layer('lines');
    const markBands = Array.from({ length: bands }, () => layer('marks'));
    const top = layer('overlay');
    this.hintLayer = el('g', {}, top);

    this.rects = [];
    this.dots = [];
    this.texts = [];
    this.look = new Int16Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
      const x = MARGIN_LEFT + (i % w) * U;
      const y = MARGIN_TOP + Math.floor(i / w) * U;
      const band = Math.floor(i / w / BAND);
      const cellLayer = fillBands[band];
      const markLayer = markBands[band];
      // Blank cells and dots are not displayed at all (rather than drawn
      // transparent or with no radius): on a big board, every element the
      // browser keeps costs time on each tap to hit-test and repaint.
      this.rects.push(el('rect', { x, y, width: U, height: U, class: 'cell', display: 'none' }, cellLayer));
      if (game.clues[i]) {
        const t = el('text', { x: x + U / 2, y: y + U / 2, class: 'clue' }, markLayer);
        t.textContent = game.clues[i];
        if (game.clues[i] >= 100) t.style.fontSize = '16px';
        this.texts.push(t);
        this.dots.push(null);
      } else {
        this.texts.push(null);
        this.dots.push(el('circle', { cx: x + U / 2, cy: y + U / 2, r: 0, class: 'dot', display: 'none' }, markLayer));
      }
    }

    // The border lies wholly outside the grid, so the edge cells keep an
    // ordinary grid line like the others: its stroke is centred on the edge
    // and clipped to the outer half. Drawn first, under the grid lines.
    const outline = `M${MARGIN_LEFT} ${MARGIN_TOP}h${w * U}v${h * U}h${-w * U}Z`;
    const clip = el('clipPath', { id: 'outside-grid' }, el('defs', {}, lineLayer));
    el('path', { d: `M0 0H${this.width}V${this.height}H0Z${outline}`, 'clip-rule': 'evenodd' }, clip);
    el('rect', {
      x: MARGIN_LEFT, y: MARGIN_TOP, width: w * U, height: h * U, class: 'grid-border', 'clip-path': 'url(#outside-grid)',
    }, lineLayer);

    // Every 4th line is heavier, to help counting.
    const lines = [outline, ''];
    for (let c = 1; c < w; c++) lines[c % 4 === 0 ? 1 : 0] += `M${MARGIN_LEFT + c * U} ${MARGIN_TOP}v${h * U}`;
    for (let r = 1; r < h; r++) lines[r % 4 === 0 ? 1 : 0] += `M${MARGIN_LEFT} ${MARGIN_TOP + r * U}h${w * U}`;
    el('path', { d: lines[0], class: 'grid-line' }, lineLayer);
    el('path', { d: lines[1], class: 'grid-line major' }, lineLayer);

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
    // One transparent rectangle on top takes every pointer event (the rest
    // ignore them, see style.css): the browser finds it at once instead of
    // testing thousands of shapes, and cellAt() works out the cell.
    el('rect', { x: 0, y: 0, width: this.width, height: this.height, class: 'hit-area' }, top);
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
      show(this.rects[i], cls !== 'cell');
      if (clues[i]) {
        const s = a.clueState[i];
        this.texts[i].setAttribute('class', s === CLUE_ERROR ? 'clue error' : s === CLUE_DONE ? 'clue done' : 'clue');
      } else {
        const dot = this.dots[i];
        show(dot, v === DOT || v === AUTO);
        dot.setAttribute('r', v === DOT ? 0.12 * U : 0.08 * U);
        dot.setAttribute('class', v === AUTO ? 'dot auto' : 'dot');
      }
    }
    this.root.classList.toggle('solved', a.solved);
    if (!a.solved) this.stopCelebration();
    this.analysis = a;
    return a;
  }

  /**
   * Just solved: shaded cells and dots fade into a soft patchwork of hues
   * from yellow-green to blue (each cell offset by a scattered phase plus a
   * diagonal sweep), shimmer for a few seconds, then settle on the solved
   * greens. With reduced motion, a short fade.
   */
  celebrate() {
    this.stopCelebration();
    const { w, n, cells } = this.game;
    const style = getComputedStyle(this.svg);
    const color = (name) => hexColor(style.getPropertyValue(name));
    // Hues swing either side of each kind's green, at its lightness and a
    // little below its saturation.
    const kinds = {
      filled: { from: color('--filled'), to: color('--ok') },
      dot: { from: color('--dot'), to: color('--ok-dot') },
    };
    for (const k of Object.values(kinds)) [k.hue, k.sat, k.light] = toHsl(k.to);
    const items = [];
    for (let i = 0; i < n; i++) {
      const kind = cells[i] === FILLED ? kinds.filled : (cells[i] === DOT || cells[i] === AUTO) && this.dots[i] ? kinds.dot : null;
      if (!kind) continue;
      const scatter = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      const phase = scatter * 160 + (Math.floor(i / w) + (i % w)) * 23;
      items.push({ node: kind === kinds.filled ? this.rects[i] : this.dots[i], kind, phase });
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduce ? 800 : 4500;
    const start = performance.now();
    this.celebrating = items;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      for (const { node, kind, phase } of items) {
        let rgb;
        if (reduce) {
          rgb = mix(kind.from, kind.to, smooth(0, 1, t));
        } else {
          const hue = kind.hue + 10 + 70 * Math.sin(((phase + t * 900) * Math.PI) / 180);
          rgb = mix(mix(kind.from, hsl(hue, kind.sat * 0.75, kind.light), smooth(0, 0.1, t)), kind.to, smooth(0.75, 1, t));
        }
        node.style.fill = `rgb(${rgb.map(Math.round).join(',')})`;
      }
      if (t < 1) this.anim = requestAnimationFrame(frame);
      else this.stopCelebration();
    };
    // Draw the first frame now: the solved colours are already in the
    // stylesheet and would otherwise flash up for a frame.
    frame(start);
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

  /**
   * Size the board to fit inside maxWidth × maxHeight, with cells at most
   * 48px and at least minCell px (then it is bigger than the space).
   */
  fit(maxWidth, maxHeight, minCell = 0) {
    this.scale = Math.max(minCell / U, Math.min(maxWidth / this.width, maxHeight / this.height, 48 / U));
    this.applyScale();
  }

  applyScale() {
    if (!this.game) return;
    // Round down so a board that fits never spills over its container.
    this.svg.setAttribute('width', Math.floor(this.width * this.scale));
    this.svg.setAttribute('height', Math.floor(this.height * this.scale));
    this.applyStrokes();
    // Lets the page centre things over the grid rather than the whole board.
    (this.root.closest('.board-wrap') || this.root).style.setProperty('--grid-shift', `${(MARGIN_LEFT - PAD) * this.scale}px`);
    // Keep coordinates at least ~8px on screen, within what fits a cell.
    this.labelLayer.style.fontSize = `${Math.min(0.5 * U, Math.max(0.35 * U, 8 / this.scale))}px`;
  }

  /** The page's pinch zoom changed (visualViewport.scale). */
  setZoom(zoom) {
    this.zoom = zoom;
    this.applyStrokes();
  }

  /**
   * Stroke widths for the stylesheet, in board units. Grid lines and the
   * border are whole screen pixels, drawn with crisp edges: a fraction of a
   * pixel would be shaded half-way, which merges with a grey cell but shows
   * against a pale one, so a line seemed to change width along its length.
   * Zooming in thickens them with the square root of the zoom, so they grow,
   * but more slowly than the cells.
   */
  applyStrokes() {
    if (!this.game) return;
    // Board units to CSS pixels as drawn (the size was rounded down).
    const scale = Math.min(Number(this.svg.getAttribute('width')) / this.width, Number(this.svg.getAttribute('height')) / this.height);
    const dpr = window.devicePixelRatio || 1;
    const grow = Math.sqrt(this.zoom);
    const device = (cssPx, min) => Math.max(min, Math.round(cssPx * dpr * grow)) / (dpr * this.zoom * scale);
    const line = device(1, 1);
    const style = this.root.style;
    style.setProperty('--px', `${1 / scale}px`);
    style.setProperty('--line', `${line}px`);
    style.setProperty('--major', `${Math.max(device(1.75, 1), line + 1 / (dpr * this.zoom * scale))}px`);
    style.setProperty('--border', `${device(2.5, 2)}px`);
    style.setProperty('--border-solved', `${device(3, 2)}px`);
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

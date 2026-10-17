// SVG board: draws a Game and turns pointer input into strokes.
//
// Elements are created once per puzzle and only re-classed when a cell's
// look changes, so a 60×60 board stays responsive while dragging.

import { columnName } from './grid.js';
import { FILLED, DOT, AUTO, CLUE_DONE, CLUE_ERROR } from './game.js';

const NS = 'http://www.w3.org/2000/svg';
/** Cell size in SVG units; the board is scaled as a whole. */
const U = 40;
const MARGIN_LEFT = 1.5 * U;
const MARGIN_TOP = 1.05 * U;
const PAD = 0.3 * U;

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
    this.dragging = false;
    this.pending = 0;
    this.hover = -1;

    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.pointerUp(e));
    svg.addEventListener('pointercancel', (e) => this.pointerUp(e));
    svg.addEventListener('pointerleave', () => this.setHover(-1));
  }

  get width() {
    return MARGIN_LEFT + this.game.w * U + PAD;
  }

  get height() {
    return MARGIN_TOP + this.game.h * U + PAD;
  }

  setGame(game) {
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
        this.texts.push(t);
        this.dots.push(null);
      } else {
        this.texts.push(null);
        this.dots.push(el('circle', { cx: x + U / 2, cy: y + U / 2, r: 0, class: 'dot' }, markLayer));
      }
    }

    let d = '';
    for (let c = 1; c < w; c++) d += `M${MARGIN_LEFT + c * U} ${MARGIN_TOP}v${h * U}`;
    for (let r = 1; r < h; r++) d += `M${MARGIN_LEFT} ${MARGIN_TOP + r * U}h${w * U}`;
    el('path', { d, class: 'grid-line' }, lineLayer);
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
    this.applyScale();
    this.render();
  }

  /** Redraw changed cells. Returns the analysis used. */
  render() {
    this.pending = 0;
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
      let cls = 'cell';
      if (v === FILLED) cls += a.adjacent[i] ? ' filled error' : ' filled';
      else if (a.isolated[i]) cls += ' isolated';
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
    this.analysis = a;
    return a;
  }

  scheduleRender() {
    if (!this.pending) this.pending = requestAnimationFrame(() => this.render());
  }

  // --- zoom -----------------------------------------------------------------

  /** Pixels per cell. */
  get cellPx() {
    return this.scale * U;
  }

  setCellPx(px) {
    this.scale = Math.min(64, Math.max(8, px)) / U;
    this.applyScale();
  }

  applyScale() {
    if (!this.game) return;
    this.svg.setAttribute('width', Math.round(this.width * this.scale));
    this.svg.setAttribute('height', Math.round(this.height * this.scale));
    // Keep coordinates at least ~8px on screen, within what fits a cell.
    this.labelLayer.style.fontSize = `${Math.min(0.5 * U, Math.max(0.35 * U, 8 / this.scale))}px`;
  }

  /** Largest cell size (16 to 48px) that fits the given box. */
  fit(maxWidth, maxHeight) {
    const s = Math.min(maxWidth / this.width, maxHeight / this.height);
    this.setCellPx(Math.min(48, Math.max(16, s * U)));
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
    if (!this.game || (e.button !== 0 && e.button !== 2)) return;
    const i = this.cellAt(e);
    if (i < 0) return;
    e.preventDefault();
    if (!this.game.beginStroke(i, e.button === 2 || e.shiftKey)) return;
    this.dragging = true;
    this.svg.setPointerCapture(e.pointerId);
    this.scheduleRender();
  }

  pointerMove(e) {
    if (!this.game) return;
    const i = this.cellAt(e);
    if (e.pointerType === 'mouse') this.setHover(i);
    if (!this.dragging) return;
    this.game.continueStroke(i);
    this.scheduleRender();
  }

  pointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.game.endStroke();
    this.render();
    this.onCommit();
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

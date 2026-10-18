// SVG board: draws a Game, turns clicks into moves, and zooms.
//
// Elements are created once per puzzle and only re-classed when a cell's
// look changes, so a 60×60 board stays responsive.
//
// A move happens on release, and only if the pointer stayed on the cell it
// pressed: dragging never marks cells. A drag scrolls the board instead
// (natively for touch, by hand for the mouse). Zoom: pinch, Ctrl/⌘ + wheel (trackpad pinch), Safari
// gesture events, or zoomBy() from buttons and keys; the point under the
// fingers or cursor stays put.

import { columnName } from './grid.js';
import { FILLED, DOT, AUTO, CLUE_DONE, CLUE_ERROR } from './game.js';

const NS = 'http://www.w3.org/2000/svg';
/** Cell size in SVG units; the board is scaled as a whole. */
const U = 40;
const MARGIN_LEFT = 1.5 * U;
const MARGIN_TOP = 1.05 * U;
const PAD = 0.3 * U;
/** Zoom range, in pixels per cell. */
const MIN_CELL_PX = 8;
const MAX_CELL_PX = 120;
/** Pointer travel (px) that turns a press into a scroll instead of a click. */
const CLICK_SLOP = 10;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

export class Board {
  /** svg: the board; wrap: its scrolling container. */
  constructor(svg, wrap, { onCommit = () => {}, onHover = () => {}, onZoom = () => {} } = {}) {
    this.svg = svg;
    this.wrap = wrap;
    this.onCommit = onCommit;
    this.onHover = onHover;
    this.onZoom = onZoom;
    this.game = null;
    this.scale = 1;
    this.press = null;
    this.pan = null;
    this.touchPointers = new Set();
    this.pinch = null;
    this.gestureStart = 0;
    this.pending = 0;
    this.hover = -1;

    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.pointerUp(e));
    svg.addEventListener('pointercancel', (e) => this.pointerEnd(e));
    svg.addEventListener('pointerleave', () => this.setHover(-1));

    wrap.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    wrap.addEventListener('touchstart', (e) => this.touch(e), { passive: false });
    wrap.addEventListener('touchmove', (e) => this.touch(e), { passive: false });
    wrap.addEventListener('touchend', (e) => this.touch(e));
    wrap.addEventListener('touchcancel', (e) => this.touch(e));
    // Safari trackpad and iOS pinch.
    wrap.addEventListener('gesturestart', (e) => this.gesture(e));
    wrap.addEventListener('gesturechange', (e) => this.gesture(e));
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

    // Every 5th line is heavier, to help counting.
    const lines = ['', ''];
    for (let c = 1; c < w; c++) lines[c % 5 === 0 ? 1 : 0] += `M${MARGIN_LEFT + c * U} ${MARGIN_TOP}v${h * U}`;
    for (let r = 1; r < h; r++) lines[r % 5 === 0 ? 1 : 0] += `M${MARGIN_LEFT} ${MARGIN_TOP + r * U}h${w * U}`;
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
      else if (v === DOT || v === AUTO) cls += ' dotted';
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
    this.scale = Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX, px)) / U;
    this.applyScale();
  }

  /**
   * Set the cell size keeping the board point under (clientX, clientY) in
   * place, scrolling the container as needed.
   */
  zoomTo(px, clientX, clientY) {
    if (!this.game) return;
    const before = this.svg.getBoundingClientRect();
    const ux = (clientX - before.left) / this.scale;
    const uy = (clientY - before.top) / this.scale;
    this.setCellPx(px);
    const after = this.svg.getBoundingClientRect();
    this.wrap.scrollLeft += after.left + ux * this.scale - clientX;
    this.wrap.scrollTop += after.top + uy * this.scale - clientY;
    this.onZoom();
  }

  /** Zoom by a factor around the middle of the visible part of the board. */
  zoomBy(factor) {
    const r = this.wrap.getBoundingClientRect();
    const s = this.svg.getBoundingClientRect();
    const x = (Math.max(r.left, s.left) + Math.min(r.right, s.right)) / 2;
    const y = (Math.max(r.top, s.top) + Math.min(r.bottom, s.bottom)) / 2;
    this.zoomTo(this.cellPx * factor, x, y);
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
    // Mouse: avoid text selection, and pan by hand if this becomes a drag.
    // Touch: leave the browser free to scroll.
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
    }
    this.press = { id: e.pointerId, cell: i, x: e.clientX, y: e.clientY, reverse: e.button === 2 || e.shiftKey };
  }

  pointerMove(e) {
    if (!this.game) return;
    const p = this.press;
    if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) {
      this.press = null;
      if (this.pan) {
        this.pan.active = true;
        this.svg.setPointerCapture(e.pointerId);
        this.wrap.classList.add('panning');
      }
    }
    const pan = this.pan;
    if (pan && pan.active && pan.id === e.pointerId) {
      this.wrap.scrollLeft -= e.clientX - pan.x;
      this.wrap.scrollTop -= e.clientY - pan.y;
      pan.x = e.clientX;
      pan.y = e.clientY;
      return;
    }
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
    if (this.pan && this.pan.id === e.pointerId) {
      this.pan = null;
      this.wrap.classList.remove('panning');
    }
  }

  /** Ctrl/⌘ + wheel, which is also what trackpad pinches send, zooms. */
  wheel(e) {
    if (!this.game || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomTo(this.cellPx * Math.exp(-dy * 0.01), e.clientX, e.clientY);
  }

  /** Two-finger pinch zooms around the fingers; one finger scrolls natively. */
  touch(e) {
    if (!this.game) return;
    const t = e.touches;
    if (t.length !== 2) {
      this.pinch = null;
      return;
    }
    e.preventDefault();
    const x = (t[0].clientX + t[1].clientX) / 2;
    const y = (t[0].clientY + t[1].clientY) / 2;
    const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    if (!this.pinch) {
      this.press = null;
      this.pinch = { dist, px: this.cellPx, x, y };
      return;
    }
    // Follow the fingers: pan by the midpoint's movement, then zoom around it.
    this.wrap.scrollLeft -= x - this.pinch.x;
    this.wrap.scrollTop -= y - this.pinch.y;
    this.pinch.x = x;
    this.pinch.y = y;
    this.zoomTo(this.pinch.px * (dist / this.pinch.dist), x, y);
  }

  /** Safari gesture events; touch pinches are already handled above. */
  gesture(e) {
    e.preventDefault();
    if (!this.game || this.pinch) return;
    if (e.type === 'gesturestart') this.gestureStart = this.cellPx;
    else this.zoomTo(this.gestureStart * e.scale, e.clientX, e.clientY);
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

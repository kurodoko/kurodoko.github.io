// Page wiring: URL parameters, generation, storage, toolbar and checkpoints.

import { Game, formatDuration } from './game.js';
import { Board } from './ui.js';
import { GENERATOR_VERSION, DIFFICULTIES, checkParams, generate } from './generator.js';
import { MIN_SIZE, MAX_SIZE, cellName } from './grid.js';
import { findMistakes, findHint, rewindToCorrect } from './hint.js';

const $ = (id) => document.getElementById(id);

// --- storage (best effort: private windows may refuse) ----------------------

const PREFIX = 'kurodoko:';

const store = {
  get(key) {
    try {
      const s = localStorage.getItem(PREFIX + key);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  },
  /** Returns false if the value could not be stored (full or unavailable). */
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // ignore
    }
  },
};

/** Keep the most recent `limit` keys in a named index, deleting older entries. */
function touchIndex(name, key, limit) {
  const index = (store.get(name) || []).filter((k) => k !== key);
  index.push(key);
  while (index.length > limit) store.remove(index.shift());
  store.set(name, index);
}

const puzzleId = (p) => `v${GENERATOR_VERSION}:${p.w}x${p.h}:${p.difficulty}:${p.seed}`;

// --- today's puzzles -----------------------------------------------------------

/** Sizes of each day's puzzles (square), all at one difficulty. */
const DAILY_SIZES = [4, 8, 12, 16, 20, 24, 32, 40, 48, 60];
const DAILY_DIFFICULTY = 'hard';

/** Today's local date as yyyymmdd: the seed of the day's puzzles. */
function todaySeed(d = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const dailyParams = (n) => ({ w: n, h: n, difficulty: DAILY_DIFFICULTY, seed: todaySeed() });

// --- URL ----------------------------------------------------------------------

function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000000);
}

function readParams() {
  const q = new URLSearchParams(location.search);
  // A plain visit opens today's smallest puzzle.
  if (!q.has('w') && !q.has('h') && !q.has('seed')) return dailyParams(DAILY_SIZES[0]);
  const size = (k) => {
    const v = Number(q.get(k));
    return Number.isInteger(v) && v >= MIN_SIZE && v <= MAX_SIZE ? v : 10;
  };
  const seed = q.get('seed');
  return {
    w: size('w'),
    h: size('h'),
    difficulty: DIFFICULTIES[q.get('d')] ? q.get('d') : 'medium',
    seed: /^-?\d{1,15}$/.test(seed || '') ? seed : randomSeed(),
    linkVersion: q.get('v'),
  };
}

function writeURL(p, push) {
  const q = new URLSearchParams({ w: p.w, h: p.h, d: p.difficulty, seed: p.seed, v: GENERATOR_VERSION });
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}?${q}`);
}

// --- generation -------------------------------------------------------------

let worker = null;
let jobId = 0;

function generateInWorker(params, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    if (worker) worker.terminate();
    const onMainThread = () => {
      worker = null;
      setTimeout(() => {
        try {
          resolve(generate({ ...params, onProgress }));
        } catch (err) {
          reject(err);
        }
      }, 20);
    };
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      onMainThread();
      return;
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.progress !== undefined) onProgress(m.progress);
      else if (m.error) reject(new Error(m.error));
      else resolve(m.puzzle);
    };
    worker.onerror = (e) => {
      // Module workers unsupported (or failed to load): fall back.
      e.preventDefault();
      worker.terminate();
      onMainThread();
    };
    worker.postMessage({ id, params });
  });
}

// --- page state -------------------------------------------------------------

let current = null;
let startToken = 0;
let saveTimer = 0;

const board = new Board($('board'), {
  onCommit: () => commit(),
  onHover: (i) => {
    $('coord').textContent = i >= 0 && current ? cellName(current.game.w, i) : '';
  },
});

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('new').disabled = busy;
}

function showProgress(f) {
  $('progress').hidden = f === null;
  if (f !== null) $('progress-bar').style.width = `${Math.round(f * 100)}%`;
}

async function start(params, { push = false } = {}) {
  saveProgress();
  const token = ++startToken;
  try {
    checkParams(params);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  fillForm(params);
  writeURL(params, push);
  const id = puzzleId(params);
  let puzzle = store.get('puzzle:' + id);
  if (!puzzle || puzzle.w !== params.w || puzzle.h !== params.h) {
    setBusy(true);
    setStatus(`Generating ${params.w}×${params.h} ${params.difficulty} puzzle…`);
    showProgress(0);
    try {
      puzzle = await generateInWorker(
        { w: params.w, h: params.h, seed: params.seed, difficulty: params.difficulty },
        (f) => token === startToken && showProgress(f),
      );
    } catch (err) {
      if (token === startToken) {
        setBusy(false);
        showProgress(null);
        setStatus(`Could not generate this puzzle: ${err.message}`, 'error');
      }
      return;
    }
    if (token !== startToken) return;
    store.set('puzzle:' + id, { w: puzzle.w, h: puzzle.h, clues: puzzle.clues, solution: puzzle.solution });
    touchIndex('puzzles', 'puzzle:' + id, 30);
  }
  setBusy(false);
  showProgress(null);

  const saved = store.get('progress:' + id);
  const game = new Game(puzzle, saved);
  // Saves from when unmarked cells could finish a puzzle.
  if (game.solvedAt && !game.analyze().solved) game.solvedAt = 0;
  current = { params, id, game, solution: puzzle.solution };
  mistakeStep = 0;
  board.setGame(game);
  fitBoard();
  updateInfo();
  renderDaily();
  renderCheckpoints();
  refresh();
  // Keep the start time even if the puzzle is left before any move.
  if (!saved) saveProgress();
  if (params.linkVersion && params.linkVersion !== String(GENERATOR_VERSION)) {
    setStatus(`This link was made with generator version ${params.linkVersion}; this is version ${GENERATOR_VERSION}, so the puzzle may differ from the one shared.`, 'note');
  }
}

function updateInfo() {
  const { params, game } = current;
  const hints = game.hints ? ` · ${plural(game.hints, 'hint')}` : '';
  $('info').textContent =
    `${params.w}×${params.h} · ${params.difficulty} · seed ${params.seed} · ${game.clues.filter(Boolean).length} numbers${hints}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** After any change to the game: clear hints, save (soon), update buttons and status. */
function commit() {
  mistakeStep = 0;
  board.setHint([]);
  // Time the solve when a move completes the puzzle (cleared if it is undone).
  const { game } = current;
  const wasSolved = game.solvedAt > 0;
  let justSolved = false;
  if (!game.analyze().solved) game.solvedAt = 0;
  else if (!game.solvedAt) {
    game.solvedAt = Date.now();
    justSolved = true;
  }
  refresh();
  if (wasSolved !== game.solvedAt > 0) renderDaily();
  if (justSolved) board.celebrate();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 250);
}

function saveProgress() {
  clearTimeout(saveTimer);
  if (!current) return;
  // Undo history is a nice-to-have: if storage is full, keep the board without it.
  const key = 'progress:' + current.id;
  if (!store.set(key, current.game.serialize())) store.set(key, current.game.serialize({ withHistory: false }));
  touchIndex('progress', 'progress:' + current.id, 100);
}

function refresh() {
  const { game } = current;
  const a = board.render();
  $('undo').disabled = game.history.length === 0;
  $('redo').disabled = game.future.length === 0;
  if (a.solved) {
    const time = game.solvedAt ? `Solved in ${formatDuration(game.solvedAt - game.startedAt)}` : 'Solved!';
    setStatus(game.hints ? `${time} (${plural(game.hints, 'hint')})` : time, 'ok');
    return;
  }
  let problems = a.adjacent.reduce((s, v) => s + v, 0) / 2;
  problems += a.clueState.reduce((s, v) => s + (v === 2 ? 1 : 0), 0);
  if (a.isolated.includes(1)) problems++;
  setStatus(problems ? `${problems} problem${problems > 1 ? 's' : ''} shown in blue.` : '');
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

/**
 * Fit the whole board in its column and in the window space below it (but at
 * least half the window height, so a short landscape phone still gets a
 * usable board and scrolls the page instead). Cells never get smaller than
 * MIN_CELL, though: a bigger board scrolls sideways in its column and down
 * the page, so it is never clipped. Zooming in is left to the browser's
 * pinch zoom.
 *
 * Sizes come from the layout viewport (documentElement.clientWidth/Height),
 * which pinch zoom and a phone's sliding address bar leave alone; innerHeight
 * changes with both and made the board jump while scrolling a zoomed page.
 */
let fittedFor = '';

/** Smallest cell size in CSS pixels: big enough for a finger, or for a mouse. */
const MIN_CELL = window.matchMedia('(pointer: coarse)').matches ? 20 : 14;

function fitBoard() {
  if (!current) return;
  const root = document.documentElement;
  const wrap = $('board-wrap');
  const above = wrap.offsetTop + $('board-tools').offsetHeight;
  const height = Math.max(0.5 * root.clientHeight, root.clientHeight - above - 16);
  board.fit(wrap.clientWidth, height, MIN_CELL);
  fittedFor = `${root.clientWidth}x${root.clientHeight}`;
  markWide();
}

/** Note whether the board is wider than its column (and so scrolls sideways). */
function markWide() {
  $('board-wrap').classList.toggle('wide', Number($('board').getAttribute('width')) > $('board-wrap').clientWidth);
}

/** Refit only when the layout really changed size, and never mid pinch-zoom. */
function onResize() {
  const root = document.documentElement;
  if (`${root.clientWidth}x${root.clientHeight}` === fittedFor) return;
  if (window.visualViewport && window.visualViewport.scale > 1.01) return;
  fitBoard();
}

// The column can also narrow without a window resize, e.g. when a scrollbar
// appears as the page grows. Refit whenever the board no longer fits it (only
// then, so a scrollbar that comes and goes cannot make the fit oscillate).
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (!current) return;
    if (Number($('board').getAttribute('width')) > $('board-wrap').clientWidth) fitBoard();
    else markWide();
  }).observe($('board-wrap'));
}

// Pinch zoom enlarges everything; the board then redraws its grid lines to
// grow more slowly than the cells (Board.applyStrokes). That happens only once
// a pinch has stopped: redrawing the whole board during the gesture left
// stale fragments on screen in Chrome on Android.
if (window.visualViewport) {
  let zoomTimer = 0;
  const setZoom = () => {
    const zoom = Math.round(100 * Math.max(1, window.visualViewport.scale)) / 100;
    if (zoom !== board.zoom) board.setZoom(zoom);
  };
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(setZoom, 250);
  });
  setZoom();
}

// --- form ---------------------------------------------------------------------

function fillForm(p) {
  $('w').value = p.w;
  $('h').value = p.h;
  $('d').value = p.difficulty;
  $('seed').value = p.seed;
}

function formParams() {
  return {
    w: Number($('w').value),
    h: Number($('h').value),
    difficulty: $('d').value,
    seed: $('seed').value.trim(),
  };
}

$('w').min = $('h').min = MIN_SIZE;
$('w').max = $('h').max = MAX_SIZE;

$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = formParams();
  if (!p.seed) p.seed = randomSeed();
  start(p, { push: true });
});

$('random-seed').addEventListener('click', () => {
  start({ ...formParams(), seed: randomSeed() }, { push: true });
});

/** Seed + 1 (a seed that would outgrow 15 digits starts again at 0). */
function nextSeed(seed) {
  const next = /^-?\d{1,15}$/.test(seed) ? String(BigInt(seed) + 1n) : '0';
  return /^-?\d{1,15}$/.test(next) ? next : '0';
}

$('next-seed').addEventListener('click', () => {
  const p = formParams();
  start({ ...p, seed: nextSeed(p.seed) }, { push: true });
});

// --- today's puzzles bar -------------------------------------------------------

const dailyButtons = DAILY_SIZES.map((n) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${n}×${n}`;
  b.addEventListener('click', () => start(dailyParams(n), { push: true }));
  $('daily').insertBefore(b, $('custom-toggle'));
  return b;
});

function isSolved(id) {
  if (current && current.id === id) return current.game.solvedAt > 0;
  const saved = store.get('progress:' + id);
  return Boolean(saved && saved.solvedAt > 0);
}

/**
 * Mark the size whose puzzle of today is on the board, and tick the ones
 * solved today. Any other puzzle (custom, or an earlier day's) marks Custom.
 */
function renderDaily() {
  let onDaily = false;
  DAILY_SIZES.forEach((n, k) => {
    const b = dailyButtons[k];
    const id = puzzleId(dailyParams(n));
    const here = Boolean(current) && current.id === id;
    const solved = isSolved(id);
    onDaily ||= here;
    b.classList.toggle('current', here);
    b.classList.toggle('solved', solved);
    if (here) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
    b.title = `Today's ${n}×${n} puzzle${solved ? ', solved' : ''}`;
  });
  $('custom-toggle').classList.toggle('current', Boolean(current) && !onDaily);
}

$('custom-toggle').addEventListener('click', () => {
  const open = $('new-form').hidden;
  $('new-form').hidden = !open;
  $('custom-toggle').setAttribute('aria-expanded', String(open));
});

// --- toolbar ------------------------------------------------------------------

function act(fn) {
  if (!current) return;
  fn(current.game);
  commit();
}

// --- hints --------------------------------------------------------------------

/**
 * With a wrong mark on the board, each press goes one step further: say there
 * is a mistake, outline the wrong marks, then go back to the last position
 * without mistakes. Any action (see commit) starts over. Otherwise a hint
 * only outlines where to look. Every press is counted.
 */
let mistakeStep = 0;

function hint() {
  if (!current) return;
  const { game, solution } = current;
  if (game.analyze().solved) return;
  game.hints++;
  const wrong = findMistakes(game, solution);
  if (wrong.length) {
    mistakeStep = Math.min(mistakeStep + 1, 3);
    if (mistakeStep === 1) {
      board.setHint([]);
      setStatus('There is a mistake.', 'tip');
    } else if (mistakeStep === 2) {
      board.setHint(wrong.map((cell) => ({ cell, kind: 'mistake' })));
      setStatus(wrong.length === 1 ? 'The wrong mark is outlined in pink.' : `The ${wrong.length} wrong marks are outlined in pink.`, 'tip');
    } else {
      const { undone, erased } = rewindToCorrect(game, solution);
      commit();
      setStatus(erased
        ? `Removed ${erased === 1 ? 'the wrong mark' : `the ${erased} wrong marks`}.`
        : `Went back ${plural(undone, 'move')} to the last position without mistakes. Redo brings them back.`, 'tip');
    }
  } else {
    mistakeStep = 0;
    const h = findHint(game);
    board.setHint([h]);
    const where = cellName(game.w, h.cell);
    setStatus(h.kind === 'number' ? `Look at the ${game.clues[h.cell]} in ${where}.` : `Look around ${where}.`, 'tip');
  }
  updateInfo();
  scheduleSave();
}

$('hint').addEventListener('click', hint);
$('undo').addEventListener('click', () => act((g) => g.undo()));
$('redo').addEventListener('click', () => act((g) => g.redo()));
$('reset').addEventListener('click', () => act((g) => g.reset()));
$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Link copied. It recreates this exact puzzle.', 'ok');
  } catch {
    setStatus(`Copy this link: ${location.href}`, 'note');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    act((g) => (e.shiftKey ? g.redo() : g.undo()));
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    act((g) => g.redo());
  } else if (!mod && !e.altKey && e.key.toLowerCase() === 'h') {
    hint();
  }
});

window.addEventListener('resize', onResize);
window.addEventListener('popstate', () => start(readParams()));
window.addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
  // The day may have changed while away.
  else renderDaily();
});

// --- checkpoints --------------------------------------------------------------

function renderCheckpoints() {
  const list = $('checkpoints');
  list.replaceChildren();
  const { game } = current;
  game.checkpoints.forEach((cp, k) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'cp-text';
    const name = document.createElement('span');
    name.className = 'cp-name';
    name.textContent = cp.name;
    const meta = document.createElement('span');
    meta.className = 'cp-meta';
    const time = new Date(cp.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    meta.textContent = `${time} · ${cp.filled} filled`;
    text.append(name, meta);
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.textContent = 'Revert';
    revert.title = `Go back to “${cp.name}” (undoable)`;
    revert.addEventListener('click', () => act((g) => g.revertCheckpoint(k)));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon';
    del.textContent = '×';
    del.title = `Delete “${cp.name}”`;
    del.setAttribute('aria-label', del.title);
    del.addEventListener('click', () => {
      game.deleteCheckpoint(k);
      renderCheckpoints();
      commit();
    });
    li.append(text, revert, del);
    list.appendChild(li);
  });
  $('no-checkpoints').hidden = game.checkpoints.length > 0;
}

$('checkpoint-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!current) return;
  current.game.saveCheckpoint($('cp-name').value.trim());
  $('cp-name').value = '';
  renderCheckpoints();
  commit();
});

start(readParams());

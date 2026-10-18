// Page wiring: URL parameters, generation, storage, toolbar and checkpoints.

import { Game } from './game.js';
import { Board } from './ui.js';
import { GENERATOR_VERSION, DIFFICULTIES, checkParams, generate } from './generator.js';
import { MIN_SIZE, MAX_SIZE, cellName } from './grid.js';

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
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage full or unavailable: progress just isn't kept.
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

// --- URL ----------------------------------------------------------------------

function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000000);
}

function readParams() {
  const q = new URLSearchParams(location.search);
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

  const game = new Game(puzzle, store.get('progress:' + id));
  current = { params, id, game };
  board.setGame(game);
  fitBoard();
  $('info').textContent =
    `${params.w}×${params.h} · ${params.difficulty} · seed ${params.seed} · ${game.clues.filter(Boolean).length} numbers`;
  renderCheckpoints();
  refresh();
  if (params.linkVersion && params.linkVersion !== String(GENERATOR_VERSION)) {
    setStatus(`This link was made with generator version ${params.linkVersion}; this is version ${GENERATOR_VERSION}, so the puzzle may differ from the one shared.`, 'note');
  }
}

/** After any change to the game: save (soon), update buttons and status. */
function commit() {
  refresh();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 250);
}

function saveProgress() {
  clearTimeout(saveTimer);
  if (!current) return;
  store.set('progress:' + current.id, current.game.serialize());
  touchIndex('progress', 'progress:' + current.id, 100);
}

function refresh() {
  const { game } = current;
  const a = board.render();
  $('undo').disabled = game.history.length === 0;
  $('redo').disabled = game.future.length === 0;
  if (a.solved) {
    setStatus('Solved!', 'ok');
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
 * usable board and scrolls the page instead). The board is never clipped;
 * zooming in is left to the browser's pinch zoom.
 */
function fitBoard() {
  if (!current) return;
  const wrap = $('board-wrap');
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  const height = Math.max(0.5 * window.innerHeight, window.innerHeight - top - 16);
  board.fit(wrap.clientWidth, height);
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

// --- toolbar ------------------------------------------------------------------

function act(fn) {
  if (!current) return;
  fn(current.game);
  commit();
}

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
  }
});

window.addEventListener('resize', fitBoard);
window.addEventListener('popstate', () => start(readParams()));
window.addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress();
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

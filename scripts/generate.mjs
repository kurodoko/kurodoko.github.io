#!/usr/bin/env node
// Generate a puzzle from the command line.
//   node scripts/generate.mjs <width> <height> <seed> [easy|medium|hard|fiendish] [--json]

import { generate } from '../src/generator.js';
import { columnName } from '../src/grid.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [w = '10', h = '10', seed = '1', difficulty = 'medium'] = args.filter((a) => !a.startsWith('--'));

const t0 = performance.now();
const p = generate({ w: Number(w), h: Number(h), seed, difficulty });
const ms = performance.now() - t0;

if (json) {
  process.stdout.write(JSON.stringify(p) + '\n');
} else {
  const cw = String(p.w + p.h - 1).length + 1;
  const pad = (s) => String(s).padStart(cw);
  console.log('    ' + Array.from({ length: p.w }, (_, c) => pad(columnName(c))).join(''));
  for (let r = 0; r < p.h; r++) {
    let line = String(r + 1).padStart(3) + ' ';
    for (let c = 0; c < p.w; c++) {
      const i = r * p.w + c;
      line += pad(p.clues[i] ? p.clues[i] : p.solution[i] ? '#' : '.');
    }
    console.log(line);
  }
  const clues = p.clues.filter(Boolean).length;
  console.log(`${p.w}x${p.h} seed=${p.seed} ${p.difficulty} layout=${p.layout} clues=${clues} score=${p.score.toFixed(3)} ${ms.toFixed(0)}ms`);
}

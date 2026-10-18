# Kurodoko

Play Kurodoko (also called Kuromasu) in the browser: **https://kurodoko.github.io**

Every puzzle is generated on the spot, has exactly one solution, and is fully
determined by its width, height, difficulty and seed, so a link such as
`https://kurodoko.github.io/?w=15&h=10&d=hard&seed=2024&v=1` always shows the
same puzzle.

## Rules

- Shade some cells. Numbered cells are never shaded.
- Shaded cells never touch side by side.
- All unshaded cells form one connected area.
- Each number counts the unshaded cells it can see along its row and column,
  itself included. Sight stops at a shaded cell or the edge.

## Controls

- Click a cell to cycle empty → dot → shaded → empty. Right-click or
  Shift-click cycles backwards. Only clicks mark cells; dragging scrolls.
- The board always fits the window and is never clipped. To look closer,
  use the browser's pinch zoom (touch screen or trackpad). Every 4th grid
  line is heavier to help counting.
- Dotted cells have a slightly paler background than untouched ones.
- Dots appear automatically (drawn smaller) next to shaded cells and go away
  when the shading does; dots you placed are never changed.
- A number turns grey as soon as it plus the dots in an unbroken line from it
  add up to the number (no shaded cells needed at the ends), or when shading
  closes its view at exactly that count. It turns blue when it can no longer
  be met. Touching shaded cells and cut-off areas also show in blue.
- Hint (H) outlines in pink where to look next: a number that decides
  something on its own, or a small area for a connectivity or what-if step.
  It never says what follows. If a mark is wrong, each press goes one step
  further: "there is a mistake", then the wrong marks outlined, then back to
  the last position without mistakes (redo restores). Any move starts that
  over. Hints are counted, and the count is saved with your progress.
- Undo/redo (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z), reset, and named
  checkpoints you can revert to at any time. Progress, checkpoints and the
  last 500 undo/redo steps are kept in the browser per puzzle, so undo still
  works after a reload.

## URL parameters

| Parameter | Meaning |
| --- | --- |
| `w`, `h` | Width and height, 4 to 60 |
| `d` | `easy`, `medium` or `hard` |
| `seed` | Any whole number (up to 15 digits) |
| `v` | Generator version the link was made with |

## How puzzles are made

All generation runs in the browser, in a Web Worker, from plain ES modules
(no build step). `src/generator.js` is a pure function of its inputs: it uses a
seeded `sfc32` generator and counts work in steps rather than milliseconds, so
results are identical across browsers and in Node. The same code therefore also
runs from the command line or in GitHub Actions if puzzles ever need to be made
in advance.

1. **Shading.** Shaded cells are placed at random. Symmetric or repeated
   shading would make parts of the puzzle copies of each other, so candidates
   whose shading happens to look symmetric are penalised. No straight run of
   unshaded cells is longer than 16, which keeps every number at most 31.
2. **Numbers.** Their positions carry a hint of symmetry (180° rotation,
   mirrors, both mirrors, 90° rotation or diagonal on square grids): each
   further member of a symmetric group is added only half the time. Working
   in rings from the border inward, numbers are added until the solver can
   determine every cell of the ring, then removed again while it still can,
   symmetric groups first. Removal tests use divide-and-conquer over an undo
   trail, so most tests reuse earlier work.
3. **Difficulty.** Easy and medium need only direct reasoning (number counts,
   no touching shaded cells, connectivity) and keep 60% and 25% spare numbers.
   Hard keeps none and allows what-if reasoning (assume a cell, find a
   contradiction), which most hard puzzles need.
4. Several candidates are built for small grids. The winner has loosely
   symmetric number positions (rewarded up to 60% of numbers having a mirror
   partner, penalised above 80% so it never looks exact), no accidental
   shading symmetry, and few numbers.

The solver (`src/solver.js`) only makes deductions that are logically forced,
so a puzzle it fills completely has exactly one solution. The tests check this
against an independent brute-force search.

Generation time measured in Node (headless Chromium is similar): 60×60
averages about 170 ms (easy and medium) and 330 ms (hard), at most about
440 ms in the benchmark. Most smaller sizes take under 60 ms; the slowest are
hard 16×16 to 20×20 at up to about 250 ms, where contradiction search is
allowed on gaps of any size.

**Versioning:** any change that alters generated puzzles must bump
`GENERATOR_VERSION` in `src/generator.js`. Links carry `v=`, and the page warns
when a link was made with a different version.

## Development

```sh
npm test                                   # node:test suites, no dependencies
node scripts/generate.mjs 20 20 7 hard     # print a puzzle in the terminal
python3 -m http.server                     # then open http://localhost:8000
```

| Path | Contents |
| --- | --- |
| `index.html`, `style.css` | Page and styles |
| `src/main.js` | URL parameters, storage, toolbar, checkpoints |
| `src/ui.js` | SVG board and pointer input |
| `src/game.js` | Player marks, automatic dots, undo, checkpoints, rule checks |
| `src/hint.js` | Mistake checks and where-to-look hints |
| `src/generator.js`, `src/solver.js`, `src/symmetry.js`, `src/rng.js`, `src/grid.js` | Generator and solver |
| `src/worker.js` | Runs the generator off the main thread |
| `test/` | Tests |

Pushing to `main` runs the tests and deploys to GitHub Pages
(`.github/workflows/deploy.yml`). In the repository settings, Pages must use
"GitHub Actions" as its source.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

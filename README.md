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
  Shift-click cycles backwards. Drag to apply the same change to more cells.
- Shading a cell dots its empty neighbours automatically (drawn smaller).
  Unshading removes only those automatic dots, never ones you placed.
- A number turns grey when its count is met exactly, and blue when it can no
  longer be met. Touching shaded cells and cut-off areas also show in blue.
- Undo/redo (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z), reset, zoom, and named
  checkpoints you can revert to at any time. Progress and checkpoints are kept
  in the browser per puzzle.

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

1. **Shading.** Shaded cells are placed under a symmetry (180° rotation,
   mirrors, both mirrors, 90° rotation or diagonal on square grids) or as a
   repeated motif. Each extra member of a symmetric group is kept only 85% of
   the time, so the symmetry is loose rather than exact. No straight run of
   unshaded cells is longer than 16, which keeps every number at most 31.
2. **Numbers.** Working in rings from the border inward, numbers are added
   until the solver can determine every cell of the ring, then removed again
   while it still can, symmetric groups first. Removal tests use
   divide-and-conquer over an undo trail, so most tests reuse earlier work.
3. **Difficulty.** Easy and medium need only direct reasoning (number counts,
   no touching shaded cells, connectivity) and keep 60% and 25% spare numbers.
   Hard keeps none and allows what-if reasoning (assume a cell, find a
   contradiction), which most hard puzzles need.
4. Several candidates are built for small grids and the one whose numbers and
   shading are most symmetric or most motif-like wins.

The solver (`src/solver.js`) only makes deductions that are logically forced,
so a puzzle it fills completely has exactly one solution. The tests check this
against an independent brute-force search.

Generation time measured in headless Chromium and Node: 60×60 averages about
140 ms (easy), 160 ms (medium) and 320 ms (hard), never above about 400 ms in
the benchmark. Most smaller sizes take under 60 ms; the slowest are hard
20×20 to 24×24 at 200–450 ms.

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
| `src/generator.js`, `src/solver.js`, `src/symmetry.js`, `src/rng.js`, `src/grid.js` | Generator and solver |
| `src/worker.js` | Runs the generator off the main thread |
| `test/` | Tests |

Pushing to `main` runs the tests and deploys to GitHub Pages
(`.github/workflows/deploy.yml`). In the repository settings, Pages must use
"GitHub Actions" as its source.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

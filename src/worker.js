// Runs the generator off the main thread.

import { generate } from './generator.js';

self.onmessage = (e) => {
  const { id, params } = e.data;
  let last = 0;
  try {
    const puzzle = generate({
      ...params,
      onProgress: (f) => {
        const now = performance.now();
        if (now - last < 50) return;
        last = now;
        self.postMessage({ id, progress: f });
      },
    });
    self.postMessage({ id, puzzle });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

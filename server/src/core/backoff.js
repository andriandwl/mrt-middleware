'use strict';

/** Exponential backoff dengan jitter. attempt mulai dari 0. */
function backoffDelay(attempt, baseMs = 1000, maxMs = 60_000) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp) + Math.min(baseMs, exp);
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

module.exports = { backoffDelay, sleep };

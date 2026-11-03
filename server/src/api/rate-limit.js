"use strict";

const { metrics } = require("../monitoring/metrics");

/**
 * Rate limit sederhana (jendela tetap 60 detik, in-memory per proses).
 * Dipakai dua kali:
 *  - per IP sebelum autentikasi (meredam brute force API key / token)
 *  - per klien setelah autentikasi (melindungi database dari konsumen yang salah konfigurasi)
 * Untuk beberapa instance di belakang load balancer, batas berlaku per instance.
 *
 * Header respons: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset (detik), dan Retry-After saat 429.
 *
 * @param {{ limit: number, keyFn: (req: import('express').Request) => string|null, name: string }} opts
 */
function rateLimit({ limit, keyFn, name }) {
  const windowMs = 60_000;
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  // bersihkan bucket kedaluwarsa agar memori tidak tumbuh
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    if (!limit) return next();
    const key = keyFn(req);
    if (!key) return next();
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const resetS = Math.ceil((b.resetAt - now) / 1000);
    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(Math.max(0, limit - b.count)));
    res.set("RateLimit-Reset", String(resetS));
    if (b.count > limit) {
      metrics.rateLimited.inc();
      res.set("Retry-After", String(resetS));
      return res
        .status(429)
        .json({
          error: "too_many_requests",
          detail: `batas ${limit} request/menit (${name}) terlampaui`,
        });
    }
    return next();
  };
}

module.exports = { rateLimit };

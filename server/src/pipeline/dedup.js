'use strict';

const { createHash } = require('node:crypto');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}

/**
 * Kunci dedup = sha256(source | sourceId | sourceTs | payload).
 * @param {import('../core/types').RawRecord} raw
 */
function dedupKey(raw) {
  return createHash('sha256')
    .update(raw.source)
    .update('|')
    .update(raw.sourceId)
    .update('|')
    .update(raw.sourceTs.toISOString())
    .update('|')
    .update(stableStringify(raw.payload))
    .digest('hex');
}

/**
 * Cache in-memory (TTL + batas jumlah) sebagai saringan cepat.
 * Penjaga akhir tetap UNIQUE constraint raw_records.dedup_key di database.
 */
class DedupCache {
  constructor(ttlMs, maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /** true bila key sudah pernah dilihat (duplikat). Bila belum, key dicatat. */
  checkAndMark(key) {
    const now = Date.now();
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return true;
    this.seen.set(key, now + this.ttlMs);
    if (this.seen.size > this.maxEntries) this.evict(now);
    return false;
  }

  forget(key) {
    this.seen.delete(key);
  }

  evict(now) {
    for (const [k, exp] of this.seen) {
      if (exp <= now || this.seen.size > this.maxEntries * 0.9) this.seen.delete(k);
      else break;
    }
  }
}

module.exports = { dedupKey, DedupCache };

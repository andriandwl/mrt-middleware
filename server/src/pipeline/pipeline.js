'use strict';

const { DedupCache, dedupKey } = require('./dedup');
const { validate } = require('./validate');
const { metrics } = require('../monitoring/metrics');
const { logger } = require('../logger');

/**
 * Alur: dedup → parse → map → normalize → validate → persist → distribute.
 * Record diproses berurutan per konektor lewat antrian terbatas.
 */
class Pipeline {
  /**
   * @param {import('../storage/repository').Repository} repo
   * @param {import('./mapper').Mapper} mapper
   * @param {import('../distribution/websocket').DistributionHub} hub
   * @param {DedupCache} dedup
   */
  constructor(repo, mapper, hub, dedup, maxQueuePerConnector = 5_000) {
    this.repo = repo;
    this.mapper = mapper;
    this.hub = hub;
    this.dedup = dedup;
    this.maxQueuePerConnector = maxQueuePerConnector;
    /** @type {Map<string, Promise<void>>} */
    this.queues = new Map();
    /** @type {Map<string, number>} */
    this.pending = new Map();
  }

  /**
   * Masukkan record ke antrian konektor (non-blocking).
   * @param {import('../core/types').RawRecord} raw
   * @param {import('../core/types').Parser} parser
   */
  submit(raw, parser) {
    const n = this.pending.get(raw.connectorId) ?? 0;
    if (n >= this.maxQueuePerConnector) {
      metrics.recordsDropped.inc({ source: raw.source, connector: raw.connectorId });
      logger.warn({ connector: raw.connectorId }, 'queue full, record dropped');
      return;
    }
    this.pending.set(raw.connectorId, n + 1);
    const prev = this.queues.get(raw.connectorId) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(raw, parser))
      .catch((err) => logger.error({ err: String(err), correlationId: raw.correlationId }, 'pipeline error'))
      .finally(() => this.pending.set(raw.connectorId, (this.pending.get(raw.connectorId) ?? 1) - 1));
    this.queues.set(raw.connectorId, next);
  }

  async process(raw, parser) {
    const labels = { source: raw.source, connector: raw.connectorId };
    const end = metrics.pipelineLatency.startTimer(labels);
    metrics.recordsReceived.inc(labels);

    // 1. Dedup (cache cepat)
    const key = dedupKey(raw);
    if (this.dedup.checkAndMark(key)) {
      metrics.recordsDuplicate.inc(labels);
      end();
      return;
    }

    // 2. Parse
    let drafts;
    try {
      drafts = parser(raw);
    } catch (err) {
      await this.reject(raw, 'parse', String(err));
      end();
      return;
    }

    // 3-5. Map + normalize + validate
    const valid = [];
    for (const d of drafts) {
      let mapped;
      try {
        mapped = this.mapper.map(d, raw);
      } catch (err) {
        await this.reject(raw, 'map', String(err));
        continue;
      }
      const v = validate(mapped);
      if (v.ok) valid.push(v.record);
      else await this.reject(raw, 'validate', v.reason);
    }

    // 6. Persist (raw + canonical dalam satu transaksi)
    try {
      const inserted = await this.repo.persist(raw, key, valid);
      if (!inserted) {
        // sudah ada di DB (duplikat setelah restart / dari instance lain)
        metrics.recordsDuplicate.inc(labels);
        end();
        return;
      }
    } catch (err) {
      this.dedup.forget(key); // izinkan diproses ulang
      logger.error({ err: String(err), correlationId: raw.correlationId }, 'persist failed');
      metrics.persistErrors.inc(labels);
      end();
      throw err;
    }

    // 7. Distribute
    for (const rec of valid) this.hub.publish(rec);
    metrics.recordsPersisted.inc(labels, valid.length);
    end();
  }

  async reject(raw, stage, reason) {
    metrics.recordsRejected.inc({ source: raw.source, connector: raw.connectorId, stage });
    logger.debug({ correlationId: raw.correlationId, stage, reason }, 'record rejected');
    await this.repo
      .insertRejected(raw, stage, reason)
      .catch((err) => logger.error({ err: String(err) }, 'failed to store rejected record'));
  }
}

module.exports = { Pipeline };

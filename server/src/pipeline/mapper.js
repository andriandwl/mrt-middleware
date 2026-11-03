'use strict';

const { logger } = require('../logger');

function normalizeValue(v, scale) {
  if (typeof v === 'number') return { valueNum: Number.isFinite(v) ? v * scale : null, valueText: null };
  if (typeof v === 'boolean') return { valueNum: v ? 1 : 0, valueText: v ? 'true' : 'false' };
  if (typeof v === 'bigint') return { valueNum: Number(v) * scale, valueText: null };
  if (typeof v === 'string') {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n)
      ? { valueNum: n * scale, valueText: null }
      : { valueNum: null, valueText: v };
  }
  if (v === null || v === undefined) return { valueNum: null, valueText: null };
  return { valueNum: null, valueText: JSON.stringify(v).slice(0, 1000) };
}

/**
 * Memetakan DraftRecord ke canonical record:
 *  1. Cari tag_mappings (source, sourceKey) → asset_id, station, metric, unit, scale.
 *  2. Bila tidak ada, pakai nilai yang diisi parser.
 *  3. Normalisasi nilai (angka/teks/boolean) dan satuan.
 * Mapping di-cache dan di-refresh berkala.
 */
class Mapper {
  /** @param {import('../storage/repository').Repository} repo */
  constructor(repo, refreshMs = 60_000) {
    this.repo = repo;
    this.refreshMs = refreshMs;
    this.cache = new Map();
    this.timer = null;
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    try {
      const rows = await this.repo.listActiveMappings();
      this.cache = new Map(rows.map((m) => [`${m.source}|${m.sourceKey}`, m]));
    } catch (err) {
      logger.error({ err: String(err) }, 'failed to refresh tag mappings');
    }
  }

  lookup(source, key) {
    return this.cache.get(`${source}|${key}`);
  }

  /**
   * @param {any} draft  DraftRecord dari parser
   * @param {import('../core/types').RawRecord} raw
   * @returns {import('../core/types').CanonicalRecord}
   */
  map(draft, raw) {
    const m = this.lookup(raw.source, draft.sourceKey);
    const sourceTs = draft.sourceTs ?? raw.sourceTs;
    const { receivedTs } = raw;

    switch (draft.kind) {
      case 'telemetry': {
        const { valueNum, valueText } = normalizeValue(draft.rawValue, m?.scale ?? 1);
        return {
          kind: 'telemetry',
          source: raw.source,
          assetId: m?.assetId ?? draft.assetId ?? draft.sourceKey,
          station: m?.station ?? draft.station ?? 'UNKNOWN',
          metric: m?.metric ?? draft.metric ?? 'value',
          valueNum,
          valueText,
          unit: m?.unit ?? draft.unit ?? null,
          quality: draft.quality ?? 'good',
          sourceTs,
          receivedTs,
        };
      }
      case 'event':
        return {
          kind: 'event',
          source: raw.source,
          assetId: m?.assetId ?? draft.assetId ?? draft.sourceKey,
          station: m?.station ?? draft.station ?? 'UNKNOWN',
          category: draft.category ?? 'device_event',
          severity: draft.severity ?? 'info',
          code: draft.code ?? null,
          message: draft.message ?? draft.sourceKey,
          state: draft.state ?? 'info',
          alarmKey: draft.alarmKey ?? null,
          sourceTs,
          receivedTs,
        };
      case 'train_info':
        return {
          kind: 'train_info',
          source: 'pids',
          station: String(m?.station ?? draft.station ?? 'UNKNOWN').toUpperCase(),
          platform: draft.platform ?? null,
          trainNo: draft.trainNo ?? null,
          refId: draft.refId ?? null,
          status: draft.status ?? null,
          direction: draft.direction ?? null,
          type: draft.type ?? 'arrival',
          scheduledTs: draft.scheduledTs ?? null,
          estimatedTs: draft.estimatedTs ?? null,
          delaySec: draft.delaySec ?? null,
          message: draft.message ?? null,
          sourceTs,
          receivedTs,
        };
      default:
        throw new Error(`Unknown draft kind: ${draft.kind}`);
    }
  }
}

module.exports = { Mapper };

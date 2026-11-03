"use strict";

/**
 * @typedef {import('../api/auth').Scope} Scope
 *
 * @typedef {Object} TagMapping
 * @property {number} id
 * @property {string} source
 * @property {string} sourceKey
 * @property {string} assetId
 * @property {string} station
 * @property {string} metric
 * @property {string|null} unit
 * @property {number} scale
 * @property {boolean} active
 *
 * @typedef {Object} ApiClient
 * @property {string} id
 * @property {string} name
 * @property {'viewer'|'operator'|'admin'} role
 * @property {string[]} scopes
 *
 * @typedef {Object} AuditEntry
 * @property {string|null} [clientId]
 * @property {string|null} [clientName]
 * @property {string|null} [role]
 * @property {'rest'|'websocket'} channel
 * @property {string|null} [method]
 * @property {string|null} [path]
 * @property {string|null} [scopeUsed]
 * @property {number|null} [statusCode]
 * @property {string|null} [ip]
 * @property {Record<string, unknown>|null} [detail]
 * @property {'api_key'|'sso'|null} [authType]
 */

const MAPPING_COLUMNS = `id, source, source_key AS "sourceKey", asset_id AS "assetId", station, metric, unit, scale, active`;
const EVENT_COLUMNS = `'event' AS kind, source, asset_id AS "assetId", station, category, severity, code, message, state,
  alarm_key AS "alarmKey", source_ts AS "sourceTs", received_ts AS "receivedTs"`;
const TRAIN_COLUMNS = `'train_info' AS kind, 'pids' AS source, station, platform, train_no AS "trainNo", ref_id AS "refId",
  status, direction, type, scheduled_ts AS "scheduledTs", estimated_ts AS "estimatedTs", delay_sec AS "delaySec", message,
  source_ts AS "sourceTs", received_ts AS "receivedTs"`;
const TELEMETRY_COLUMNS = `'telemetry' AS kind, source, asset_id AS "assetId", station, metric, value_num AS "valueNum",
  value_text AS "valueText", unit, quality, source_ts AS "sourceTs", received_ts AS "receivedTs"`;

/** Bangun klausa WHERE untuk scope "source:station" (wildcard "*"). */
function scopeClause(scopes, params, sourceExpr, stationCol) {
  if (!scopes.length) return "FALSE";
  const parts = scopes.map((s) => {
    const conds = [];
    if (s.source !== "*") {
      params.push(s.source);
      conds.push(`${sourceExpr} = $${params.length}`);
    }
    if (s.station !== "*") {
      params.push(s.station);
      conds.push(`${stationCol} = $${params.length}`);
    }
    return conds.length ? `(${conds.join(" AND ")})` : "TRUE";
  });
  return `(${parts.join(" OR ")})`;
}

function addFilter(where, params, sql, value) {
  if (value === undefined || value === null || value === "") return;
  params.push(value);
  where.push(sql.replace("?", `$${params.length}`));
}

class Repository {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }

  /**
   * Simpan raw + canonical dalam satu transaksi.
   * Return false bila raw sudah ada (dedup_key bentrok) — tidak ada yang disimpan.
   * @param {import('../core/types').RawRecord} raw
   * @param {string} dedupKey
   * @param {import('../core/types').CanonicalRecord[]} records
   */
  async persist(raw, dedupKey, records) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `INSERT INTO raw_records (source, connector_id, source_id, source_ts, received_ts, dedup_key, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (dedup_key, source_ts) DO NOTHING
         RETURNING id`,
        [
          raw.source,
          raw.connectorId,
          raw.sourceId,
          raw.sourceTs,
          raw.receivedTs,
          dedupKey,
          JSON.stringify(raw.payload ?? null),
        ],
      );
      if (r.rowCount === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      const rawId = r.rows[0].id;
      for (const rec of records)
        await Repository.insertCanonical(client, rawId, rec);
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  static async insertCanonical(c, rawId, rec) {
    switch (rec.kind) {
      case "telemetry":
        await c.query(
          `INSERT INTO telemetry (raw_id, source, asset_id, station, metric, value_num, value_text, unit, quality, source_ts, received_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            rawId,
            rec.source,
            rec.assetId,
            rec.station,
            rec.metric,
            rec.valueNum,
            rec.valueText,
            rec.unit,
            rec.quality,
            rec.sourceTs,
            rec.receivedTs,
          ],
        );
        return;
      case "event":
        await c.query(
          `INSERT INTO events (raw_id, source, asset_id, station, category, severity, code, message, state, alarm_key, source_ts, received_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            rawId,
            rec.source,
            rec.assetId,
            rec.station,
            rec.category,
            rec.severity,
            rec.code,
            rec.message,
            rec.state,
            rec.alarmKey ?? null,
            rec.sourceTs,
            rec.receivedTs,
          ],
        );
        return;
      case "train_info":
        await c.query(
          `INSERT INTO train_info (raw_id, station, platform, train_no, ref_id, status, direction, type, scheduled_ts, estimated_ts, delay_sec, message, source_ts, received_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            rawId,
            rec.station,
            rec.platform,
            rec.trainNo,
            rec.refId ?? null,
            rec.status ?? null,
            rec.direction,
            rec.type,
            rec.scheduledTs,
            rec.estimatedTs,
            rec.delaySec,
            rec.message,
            rec.sourceTs,
            rec.receivedTs,
          ],
        );
        return;
      default:
        throw new Error(`Unknown record kind: ${rec.kind}`);
    }
  }

  async insertRejected(raw, stage, reason) {
    await this.pool.query(
      `INSERT INTO rejected_records (source, connector_id, stage, reason, payload) VALUES ($1,$2,$3,$4,$5)`,
      [
        raw.source,
        raw.connectorId,
        stage,
        reason.slice(0, 2000),
        JSON.stringify(raw.payload ?? null),
      ],
    );
  }

  // ---------- Mapping ----------

  /** @returns {Promise<TagMapping[]>} */
  async listActiveMappings() {
    const r = await this.pool.query(
      `SELECT ${MAPPING_COLUMNS} FROM tag_mappings WHERE active = true`,
    );
    return r.rows;
  }

  /** @returns {Promise<TagMapping[]>} */
  async listMappings(source) {
    const params = [];
    const where = [];
    addFilter(where, params, "source = ?", source);
    const r = await this.pool.query(
      `SELECT ${MAPPING_COLUMNS} FROM tag_mappings ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY source, source_key`,
      params,
    );
    return r.rows;
  }

  /** @param {Omit<TagMapping, 'id'>} m @returns {Promise<TagMapping>} */
  async upsertMapping(m) {
    const r = await this.pool.query(
      `INSERT INTO tag_mappings (source, source_key, asset_id, station, metric, unit, scale, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (source, source_key) DO UPDATE SET
         asset_id = EXCLUDED.asset_id, station = EXCLUDED.station, metric = EXCLUDED.metric,
         unit = EXCLUDED.unit, scale = EXCLUDED.scale, active = EXCLUDED.active, updated_at = now()
       RETURNING ${MAPPING_COLUMNS}`,
      [
        m.source,
        m.sourceKey,
        m.assetId,
        m.station,
        m.metric,
        m.unit,
        m.scale,
        m.active,
      ],
    );
    return r.rows[0];
  }

  // ---------- Status konektor ----------

  /** @param {import('../core/types').ConnectorStatus} s */
  async upsertConnectorStatus(s) {
    await this.pool.query(
      `INSERT INTO connector_status (connector_id, source, state, last_error, last_record_ts, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (connector_id) DO UPDATE SET
         state = EXCLUDED.state, last_error = EXCLUDED.last_error,
         last_record_ts = COALESCE(EXCLUDED.last_record_ts, connector_status.last_record_ts), updated_at = now()`,
      [s.id, s.source, s.state, s.lastError, s.lastRecordTs],
    );
  }

  // ---------- Query untuk konsumen (selalu difilter scope) ----------

  /** @param {Scope[]} scopes */
  async queryTelemetry(scopes, q) {
    const params = [];
    const where = [scopeClause(scopes, params, "source", "station")];
    addFilter(where, params, "source = ?", q.source);
    addFilter(where, params, "station = ?", q.station);
    addFilter(where, params, "asset_id = ?", q.assetId);
    addFilter(where, params, "metric = ?", q.metric);
    addFilter(where, params, "source_ts >= ?", q.from);
    addFilter(where, params, "source_ts <= ?", q.to);
    params.push(q.limit);
    const r = await this.pool.query(
      `SELECT ${TELEMETRY_COLUMNS} FROM telemetry WHERE ${where.join(" AND ")}
       ORDER BY source_ts DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * Agregat telemetri per jam (avg/min/max/terakhir), untuk tren jangka panjang.
   * Disimpan lebih lama dari data detail (RETENTION_TELEMETRY_HOURLY_DAYS).
   * @param {Scope[]} scopes
   */
  async queryTelemetryHourly(scopes, q) {
    const params = [];
    const where = [scopeClause(scopes, params, "source", "station")];
    addFilter(where, params, "source = ?", q.source);
    addFilter(where, params, "station = ?", q.station);
    addFilter(where, params, "asset_id = ?", q.assetId);
    addFilter(where, params, "metric = ?", q.metric);
    addFilter(where, params, "hour >= ?", q.from);
    addFilter(where, params, "hour <= ?", q.to);
    params.push(q.limit);
    const r = await this.pool.query(
      `SELECT source, station, asset_id AS "assetId", metric, unit, hour, n AS "samples",
              avg_num AS "avg", min_num AS "min", max_num AS "max", last_num AS "lastNum", last_text AS "lastText",
              last_ts AS "lastTs"
       FROM telemetry_hourly WHERE ${where.join(" AND ")}
       ORDER BY hour DESC, asset_id, metric LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /** Nilai terakhir per (asset_id, metric) dalam 24 jam terakhir. @param {Scope[]} scopes */
  async latestTelemetry(scopes, q) {
    const params = [];
    const where = [
      scopeClause(scopes, params, "source", "station"),
      `source_ts >= now() - interval '1 day'`,
    ];
    addFilter(where, params, "source = ?", q.source);
    addFilter(where, params, "station = ?", q.station);
    const r = await this.pool.query(
      `SELECT DISTINCT ON (asset_id, metric) ${TELEMETRY_COLUMNS}
       FROM telemetry WHERE ${where.join(" AND ")}
       ORDER BY asset_id, metric, source_ts DESC`,
      params,
    );
    return r.rows;
  }

  /** @param {Scope[]} scopes */
  async queryEvents(scopes, q) {
    const params = [];
    const where = [scopeClause(scopes, params, "source", "station")];
    addFilter(where, params, "source = ?", q.source);
    addFilter(where, params, "station = ?", q.station);
    addFilter(where, params, "severity = ?", q.severity);
    addFilter(where, params, "state = ?", q.state);
    addFilter(
      where,
      params,
      "category = ANY(?)",
      q.categories?.length ? q.categories : undefined,
    );
    addFilter(where, params, "source_ts >= ?", q.from);
    addFilter(where, params, "source_ts <= ?", q.to);
    params.push(q.limit);
    const r = await this.pool.query(
      `SELECT ${EVENT_COLUMNS}
       FROM events WHERE ${where.join(" AND ")} ORDER BY source_ts DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * Alarm yang masih aktif: event terakhir per alarm_key (7 hari terakhir) yang state-nya 'active'.
   * @param {Scope[]} scopes
   */
  async activeAlarms(scopes, q) {
    const params = [];
    const where = [
      scopeClause(scopes, params, "source", "station"),
      "alarm_key IS NOT NULL",
      `source_ts >= now() - interval '7 days'`,
    ];
    addFilter(where, params, "source = ?", q.source);
    addFilter(where, params, "station = ?", q.station);
    const outer = [`state = 'active'`];
    addFilter(outer, params, "severity = ?", q.severity);
    params.push(q.limit);
    const r = await this.pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (alarm_key) ${EVENT_COLUMNS}
         FROM events WHERE ${where.join(" AND ")}
         ORDER BY alarm_key, source_ts DESC, id DESC
       ) latest
       WHERE ${outer.join(" AND ")}
       ORDER BY "sourceTs" DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /** @param {Scope[]} scopes */
  async queryTrainInfo(scopes, q) {
    const params = [];
    const where = [scopeClause(scopes, params, `'pids'`, "station")];
    addFilter(where, params, "station = ?", q.station);
    addFilter(where, params, "platform = ?", q.platform);
    addFilter(where, params, "type = ?", q.type);
    addFilter(where, params, "source_ts >= ?", q.from);
    addFilter(where, params, "source_ts <= ?", q.to);
    params.push(q.limit);
    const r = await this.pool.query(
      `SELECT ${TRAIN_COLUMNS}
       FROM train_info WHERE ${where.join(" AND ")} ORDER BY source_ts DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * Papan kedatangan terkini: status terakhir per (stasiun, peron, perjalanan) dalam 2 jam terakhir yang
   * belum berangkat, plus gangguan yang masih aktif (status terakhir per gangguan = DISRUPTION_ACTIVE).
   * @param {Scope[]} scopes
   */
  async trainBoard(scopes, q) {
    const params = [];
    const where = [
      scopeClause(scopes, params, `'pids'`, "station"),
      `source_ts >= now() - interval '2 hours'`,
    ];
    addFilter(where, params, "station = ?", q.station);
    const trains = await this.pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (station, platform, ref_id) ${TRAIN_COLUMNS}
         FROM train_info WHERE ${where.join(" AND ")} AND type <> 'disruption' AND ref_id IS NOT NULL
         ORDER BY station, platform, ref_id, source_ts DESC, id DESC
       ) latest
       WHERE status IS DISTINCT FROM 'DEPARTED'
         AND COALESCE("estimatedTs", "scheduledTs") >= now() - interval '3 minutes'
       ORDER BY station, platform, COALESCE("estimatedTs", "scheduledTs")`,
      params,
    );

    const params2 = [];
    const where2 = [
      scopeClause(scopes, params2, `'pids'`, "station"),
      `source_ts >= now() - interval '6 hours'`,
    ];
    addFilter(where2, params2, "station = ?", q.station);
    const disruptions = await this.pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (station, ref_id) ${TRAIN_COLUMNS}
         FROM train_info WHERE ${where2.join(" AND ")} AND type = 'disruption'
         ORDER BY station, ref_id, source_ts DESC, id DESC
       ) latest
       WHERE status = 'DISRUPTION_ACTIVE'
       ORDER BY "sourceTs" DESC`,
      params2,
    );

    // Kelompokkan per stasiun → peron, maks `perPlatform` kereta berikutnya
    const byStation = new Map();
    const ensure = (st) => {
      if (!byStation.has(st))
        byStation.set(st, { station: st, platforms: {}, disruptions: [] });
      return byStation.get(st);
    };
    for (const t of trains.rows) {
      const s = ensure(t.station);
      const list = (s.platforms[t.platform ?? "-"] ??= []);
      if (list.length < q.perPlatform) list.push(t);
    }
    for (const d of disruptions.rows) ensure(d.station).disruptions.push(d);
    return [...byStation.values()];
  }

  // ---------- Klien & audit ----------

  /** @returns {Promise<ApiClient|null>} */
  async findClientByKeyHash(hash) {
    const r = await this.pool.query(
      `SELECT id, name, role, scopes FROM api_clients
       WHERE key_hash = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())`,
      [hash],
    );
    return r.rows[0] ?? null;
  }

  /** @returns {Promise<ApiClient & { expiresAt: Date|null }>} */
  async createClient(name, keyHash, role, scopes, expiresAt = null) {
    const r = await this.pool.query(
      `INSERT INTO api_clients (name, key_hash, role, scopes, expires_at) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, role, scopes, expires_at AS "expiresAt"`,
      [name, keyHash, role, scopes, expiresAt],
    );
    return r.rows[0];
  }

  // ---------- Mapping SSO (Azure AD App Role / grup → role + scope) ----------

  async listSsoMappings({ activeOnly = false } = {}) {
    const r = await this.pool.query(
      `SELECT id, claim_type AS "claimType", claim_value AS "claimValue", role, scopes, description, active,
              updated_at AS "updatedAt"
       FROM sso_role_mappings ${activeOnly ? "WHERE active = true" : ""} ORDER BY claim_type, claim_value`,
    );
    return r.rows;
  }

  async upsertSsoMapping(m) {
    const r = await this.pool.query(
      `INSERT INTO sso_role_mappings (claim_type, claim_value, role, scopes, description, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (claim_type, claim_value) DO UPDATE SET
         role = EXCLUDED.role, scopes = EXCLUDED.scopes, description = EXCLUDED.description,
         active = EXCLUDED.active, updated_at = now()
       RETURNING id, claim_type AS "claimType", claim_value AS "claimValue", role, scopes, description, active`,
      [
        m.claimType,
        m.claimValue,
        m.role,
        m.scopes,
        m.description ?? null,
        m.active ?? true,
      ],
    );
    return r.rows[0];
  }

  async deleteSsoMapping(claimType, claimValue) {
    const r = await this.pool.query(
      `DELETE FROM sso_role_mappings WHERE claim_type = $1 AND claim_value = $2`,
      [claimType, claimValue],
    );
    return r.rowCount > 0;
  }

  /** @param {AuditEntry} e */
  async insertAudit(e) {
    await this.pool.query(
      `INSERT INTO audit_logs (client_id, client_name, role, channel, method, path, scope_used, status_code, ip, detail, auth_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        e.clientId ?? null,
        e.clientName ?? null,
        e.role ?? null,
        e.channel,
        e.method ?? null,
        e.path ?? null,
        e.scopeUsed ?? null,
        e.statusCode ?? null,
        e.ip ?? null,
        e.detail ? JSON.stringify(e.detail) : null,
        e.authType ?? null,
      ],
    );
  }
}

module.exports = { Repository };

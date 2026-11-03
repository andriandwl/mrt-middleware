"use strict";

const { env } = require("../config");
const { logger } = require("../logger");
const { metrics } = require("../monitoring/metrics");

/**
 * Daftar tabel berpartisi: nama, granularitas partisi, dan retensi (hari, 0 = simpan selamanya).
 * Partisi dibuat ke depan (7 hari untuk harian, 2 bulan untuk bulanan) dan ke belakang 8 hari / 1 bulan
 * supaya data yang terlambat (≤ 7 hari) tetap punya partisi.
 */
function tables() {
  return [
    { name: "raw_records", gran: "day", keepDays: env.RETENTION_RAW_DAYS },
    { name: "telemetry", gran: "day", keepDays: env.RETENTION_TELEMETRY_DAYS },
    {
      name: "telemetry_hourly",
      gran: "month",
      keepDays: env.RETENTION_TELEMETRY_HOURLY_DAYS,
    },
    { name: "events", gran: "month", keepDays: env.RETENTION_EVENTS_DAYS },
    {
      name: "train_info",
      gran: "month",
      keepDays: env.RETENTION_TRAIN_INFO_DAYS,
    },
    { name: "audit_logs", gran: "month", keepDays: env.RETENTION_AUDIT_DAYS },
  ];
}

const LOCK_ID = 7_310_001; // advisory lock: hanya satu instance yang menjalankan maintenance

/**
 * Satu putaran maintenance:
 *  1. pastikan partisi tersedia (ke depan & ke belakang)
 *  2. hitung agregat telemetri per jam untuk 3 jam lengkap terakhir (menangkap data terlambat)
 *  3. hapus partisi yang melewati masa retensi
 *  4. laporkan jumlah baris di partisi default (seharusnya 0)
 * @param {import('pg').Pool} pool
 */
async function runMaintenance(pool, { aggregateHours = 3 } = {}) {
  const client = await pool.connect();
  const summary = {
    createdPartitions: 0,
    droppedPartitions: [],
    aggregatedRows: 0,
    defaultRows: {},
    skipped: false,
  };
  const end = metrics.maintenanceDuration.startTimer();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [LOCK_ID],
    );
    if (!rows[0].ok) {
      summary.skipped = true;
      return summary;
    }
    try {
      // 1. partisi
      for (const t of tables()) {
        const back = t.gran === "day" ? "8 days" : "1 month";
        const ahead = t.gran === "day" ? "7 days" : "2 months";
        const r = await client.query(
          `SELECT mw_ensure_partitions($1, $1, $2, now() - $3::interval, now() + $4::interval) AS n`,
          [t.name, t.gran, back, ahead],
        );
        summary.createdPartitions += r.rows[0].n;
      }

      // 2. agregat per jam (jam yang sudah lengkap saja)
      const agg = await client.query(
        `INSERT INTO telemetry_hourly
           (source, station, asset_id, metric, unit, hour, n, avg_num, min_num, max_num, last_num, last_text, last_ts)
         SELECT source, station, asset_id, metric, max(unit), date_trunc('hour', source_ts) AS hour, count(*),
                avg(value_num), min(value_num), max(value_num),
                (array_agg(value_num ORDER BY source_ts DESC))[1],
                (array_agg(value_text ORDER BY source_ts DESC))[1],
                max(source_ts)
         FROM telemetry
         WHERE source_ts >= date_trunc('hour', now()) - make_interval(hours => $1)
           AND source_ts < date_trunc('hour', now())
         GROUP BY source, station, asset_id, metric, date_trunc('hour', source_ts)
         ON CONFLICT (asset_id, metric, hour) DO UPDATE SET
           source = EXCLUDED.source, station = EXCLUDED.station, unit = EXCLUDED.unit, n = EXCLUDED.n,
           avg_num = EXCLUDED.avg_num, min_num = EXCLUDED.min_num, max_num = EXCLUDED.max_num,
           last_num = EXCLUDED.last_num, last_text = EXCLUDED.last_text, last_ts = EXCLUDED.last_ts`,
        [aggregateHours],
      );
      summary.aggregatedRows = agg.rowCount;

      // 3. retensi
      for (const t of tables()) {
        if (!t.keepDays) continue;
        const r = await client.query(
          `SELECT mw_drop_partitions_before($1, $1, $2, now() - make_interval(days => $3)) AS name`,
          [t.name, t.gran, t.keepDays],
        );
        for (const row of r.rows) {
          summary.droppedPartitions.push(row.name);
          metrics.partitionsDropped.inc({ table: t.name });
        }
      }

      // 4. partisi default
      for (const t of tables()) {
        const r = await client.query(
          `SELECT count(*)::int AS n FROM ${t.name}_default`,
        );
        summary.defaultRows[t.name] = r.rows[0].n;
        metrics.defaultPartitionRows.set({ table: t.name }, r.rows[0].n);
      }

      metrics.maintenanceLastSuccess.set(Date.now() / 1000);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
    return summary;
  } catch (err) {
    metrics.maintenanceErrors.inc();
    throw err;
  } finally {
    end();
    client.release();
  }
}

/** Jalankan berkala di dalam proses server. */
function startMaintenanceScheduler(pool) {
  if (!env.MAINTENANCE_INTERVAL_MIN) {
    logger.info("maintenance scheduler disabled (MAINTENANCE_INTERVAL_MIN=0)");
    return () => undefined;
  }
  // Mulai hitung dari waktu start, supaya alert MaintenanceStale tidak menyala palsu setiap restart
  // (alert tetap menyala bila tidak ada maintenance yang berhasil dalam 3 jam sejak start).
  metrics.maintenanceLastSuccess.set(Date.now() / 1000);
  const run = () =>
    runMaintenance(pool)
      .then((s) => {
        if (s.skipped) return;
        const dirty = Object.entries(s.defaultRows).filter(([, n]) => n > 0);
        logger.info(
          {
            created: s.createdPartitions,
            dropped: s.droppedPartitions,
            aggregated: s.aggregatedRows,
          },
          "maintenance done",
        );
        if (dirty.length)
          logger.warn(
            { defaultRows: Object.fromEntries(dirty) },
            "rows landed in default partition",
          );
      })
      .catch((err) => logger.error({ err: String(err) }, "maintenance failed"));
  const first = setTimeout(run, 10_000);
  const timer = setInterval(run, env.MAINTENANCE_INTERVAL_MIN * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { runMaintenance, startMaintenanceScheduler, tables };

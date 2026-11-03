"use strict";

const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "mrt_mw_" });

const labelNames = ["source", "connector"];

/** Diisi oleh bindRuntime() saat startup, dibaca saat Prometheus scrape. */
const runtime = { connectors: [], pipeline: null, repo: null };

const metrics = {
  // ---------- pipeline ----------
  recordsReceived: new client.Counter({
    name: "mrt_mw_records_received_total",
    help: "Record mentah diterima dari konektor",
    labelNames,
    registers: [registry],
  }),
  recordsPersisted: new client.Counter({
    name: "mrt_mw_records_persisted_total",
    help: "Canonical record tersimpan",
    labelNames,
    registers: [registry],
  }),
  recordsDuplicate: new client.Counter({
    name: "mrt_mw_records_duplicate_total",
    help: "Record duplikat diabaikan",
    labelNames,
    registers: [registry],
  }),
  recordsRejected: new client.Counter({
    name: "mrt_mw_records_rejected_total",
    help: "Record ditolak per tahap (parse/map/validate)",
    labelNames: [...labelNames, "stage"],
    registers: [registry],
  }),
  recordsDropped: new client.Counter({
    name: "mrt_mw_records_dropped_total",
    help: "Record dibuang karena antrian penuh",
    labelNames,
    registers: [registry],
  }),
  persistErrors: new client.Counter({
    name: "mrt_mw_persist_errors_total",
    help: "Gagal menyimpan ke database",
    labelNames,
    registers: [registry],
  }),
  pipelineLatency: new client.Histogram({
    name: "mrt_mw_pipeline_seconds",
    help: "Durasi pemrosesan record dari terima sampai distribusi",
    labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  queueDepth: new client.Gauge({
    name: "mrt_mw_queue_depth",
    help: "Record yang menunggu diproses per konektor",
    labelNames: ["connector"],
    registers: [registry],
    collect() {
      this.reset();
      const pending = runtime.pipeline?.pending;
      if (pending)
        for (const [connector, n] of pending)
          this.set({ connector }, Math.max(0, n));
    },
  }),

  // ---------- konektor ----------
  connectorUp: new client.Gauge({
    name: "mrt_mw_connector_up",
    help: "1 bila konektor tersambung",
    labelNames,
    registers: [registry],
  }),
  connectorLastRecordAge: new client.Gauge({
    name: "mrt_mw_connector_last_record_age_seconds",
    help: "Detik sejak data terakhir diterima dari konektor (-1 = belum pernah)",
    labelNames,
    registers: [registry],
    collect() {
      this.reset();
      for (const c of runtime.connectors) {
        const s = c.status();
        const age = s.lastRecordTs
          ? (Date.now() - new Date(s.lastRecordTs).getTime()) / 1000
          : -1;
        this.set({ source: s.source, connector: s.id }, Math.round(age));
      }
    },
  }),
  connectorReconnects: new client.Gauge({
    name: "mrt_mw_connector_reconnect_attempts",
    help: "Percobaan reconnect berturut-turut saat ini",
    labelNames,
    registers: [registry],
    collect() {
      this.reset();
      for (const c of runtime.connectors) {
        const s = c.status();
        this.set({ source: s.source, connector: s.id }, s.reconnectAttempts);
      }
    },
  }),

  // ---------- database ----------
  dbUp: new client.Gauge({
    name: "mrt_mw_db_up",
    help: "1 bila database merespons",
    registers: [registry],
    async collect() {
      try {
        await runtime.repo?.ping();
        this.set(1);
      } catch {
        this.set(0);
      }
    },
  }),

  // ---------- maintenance (partisi, agregat, retensi) ----------
  maintenanceDuration: new client.Histogram({
    name: "mrt_mw_maintenance_seconds",
    help: "Durasi satu putaran maintenance database",
    buckets: [0.5, 1, 5, 15, 60, 300],
    registers: [registry],
  }),
  maintenanceLastSuccess: new client.Gauge({
    name: "mrt_mw_maintenance_last_success_timestamp_seconds",
    help: "Waktu (unix) maintenance terakhir yang berhasil",
    registers: [registry],
  }),
  maintenanceErrors: new client.Counter({
    name: "mrt_mw_maintenance_errors_total",
    help: "Maintenance yang gagal",
    registers: [registry],
  }),
  partitionsDropped: new client.Counter({
    name: "mrt_mw_partitions_dropped_total",
    help: "Partisi yang dihapus karena retensi",
    labelNames: ["table"],
    registers: [registry],
  }),
  defaultPartitionRows: new client.Gauge({
    name: "mrt_mw_default_partition_rows",
    help: "Baris di partisi default (seharusnya 0)",
    labelNames: ["table"],
    registers: [registry],
  }),

  // ---------- konsumen ----------
  wsClients: new client.Gauge({
    name: "mrt_mw_ws_clients",
    help: "Jumlah klien WebSocket terautentikasi",
    registers: [registry],
  }),
  authFailures: new client.Counter({
    name: "mrt_mw_auth_failures_total",
    help: "Autentikasi ditolak (401/403)",
    labelNames: ["status"],
    registers: [registry],
  }),
  rateLimited: new client.Counter({
    name: "mrt_mw_rate_limited_total",
    help: "Request ditolak karena melewati rate limit",
    registers: [registry],
  }),
};

/** Hubungkan objek runtime agar metric berbasis `collect` bisa membaca kondisi terkini. */
function bindRuntime({ connectors, pipeline, repo }) {
  runtime.connectors = connectors ?? [];
  runtime.pipeline = pipeline ?? null;
  runtime.repo = repo ?? null;
}

module.exports = { registry, metrics, bindRuntime };

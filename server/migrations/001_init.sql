-- 001_init.sql — skema awal middleware integrasi
-- Semua timestamp disimpan dalam UTC (timestamptz).

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Payload mentah dari sumber, untuk audit & reprocessing
CREATE TABLE IF NOT EXISTS raw_records (
  id            bigserial PRIMARY KEY,
  source        text        NOT NULL CHECK (source IN ('scada','nms','pids')),
  connector_id  text        NOT NULL,
  source_id     text        NOT NULL,
  source_ts     timestamptz NOT NULL,
  received_ts   timestamptz NOT NULL DEFAULT now(),
  dedup_key     text        NOT NULL UNIQUE,
  payload       jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_source_ts ON raw_records (source, source_ts DESC);

-- Record yang gagal parsing/validasi
CREATE TABLE IF NOT EXISTS rejected_records (
  id            bigserial PRIMARY KEY,
  source        text        NOT NULL,
  connector_id  text        NOT NULL,
  stage         text        NOT NULL,          -- parse | validate | map
  reason        text        NOT NULL,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Pemetaan tag/OID/field sumber ke aset internal
CREATE TABLE IF NOT EXISTS tag_mappings (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  source_key  text NOT NULL,                   -- nodeId OPC UA, OID, nama field, dst.
  asset_id    text NOT NULL,
  station     text NOT NULL,
  metric      text NOT NULL,
  unit        text,
  scale       double precision NOT NULL DEFAULT 1,
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_key)
);

-- Canonical: nilai terukur / status berkala
CREATE TABLE IF NOT EXISTS telemetry (
  id           bigserial PRIMARY KEY,
  raw_id       bigint REFERENCES raw_records(id),
  source       text        NOT NULL,
  asset_id     text        NOT NULL,
  station      text        NOT NULL,
  metric       text        NOT NULL,
  value_num    double precision,
  value_text   text,
  unit         text,
  quality      text        NOT NULL DEFAULT 'good',   -- good | uncertain | bad
  source_ts    timestamptz NOT NULL,
  received_ts  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tel_asset_metric_ts ON telemetry (asset_id, metric, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tel_station_ts      ON telemetry (station, source_ts DESC);

-- Canonical: kejadian / alarm
CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  raw_id       bigint REFERENCES raw_records(id),
  source       text        NOT NULL,
  asset_id     text        NOT NULL,
  station      text        NOT NULL,
  category     text        NOT NULL,             -- alarm | status_change | device_event | log
  severity     text        NOT NULL,             -- info | minor | major | critical
  code         text,
  message      text        NOT NULL,
  state        text        NOT NULL DEFAULT 'active',  -- active | cleared | info
  source_ts    timestamptz NOT NULL,
  received_ts  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evt_station_ts  ON events (station, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_evt_severity_ts ON events (severity, source_ts DESC);

-- Canonical: informasi perjalanan dari PIDS
CREATE TABLE IF NOT EXISTS train_info (
  id            bigserial PRIMARY KEY,
  raw_id        bigint REFERENCES raw_records(id),
  station       text        NOT NULL,
  platform      text,
  train_no      text,
  direction     text,
  type          text        NOT NULL,            -- arrival | departure | delay | disruption
  scheduled_ts  timestamptz,
  estimated_ts  timestamptz,
  delay_sec     integer,
  message       text,
  source_ts     timestamptz NOT NULL,
  received_ts   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_train_station_ts ON train_info (station, source_ts DESC);

-- Klien API (konsumen)
CREATE TABLE IF NOT EXISTS api_clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL UNIQUE,
  key_hash      text        NOT NULL UNIQUE,     -- sha256 hex dari API key
  role          text        NOT NULL CHECK (role IN ('viewer','operator','admin')),
  scopes        text[]      NOT NULL DEFAULT '{}', -- contoh: {'scada:*','pids:LBB'}
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Audit akses konsumen (append-only)
CREATE TABLE IF NOT EXISTS audit_logs (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  client_id    uuid,
  client_name  text,
  role         text,
  channel      text        NOT NULL,             -- rest | websocket
  method       text,
  path         text,
  scope_used   text,
  status_code  integer,
  ip           text,
  detail       jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs (ts DESC);

-- Status konektor terakhir
CREATE TABLE IF NOT EXISTS connector_status (
  connector_id   text PRIMARY KEY,
  source         text        NOT NULL,
  state          text        NOT NULL,           -- connecting | connected | disconnected | error | stopped
  last_error     text,
  last_record_ts timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Audit log append-only: cegah UPDATE/DELETE dari aplikasi
CREATE OR REPLACE FUNCTION audit_logs_block_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_modify();

-- 004_partitioning.sql — Fase 4: partisi tabel berdasarkan waktu + agregat telemetri per jam
--
-- Tabel besar diubah menjadi tabel berpartisi (PostgreSQL native, RANGE pada kolom waktu, batas UTC):
--   raw_records  (source_ts)  per hari     telemetry   (source_ts) per hari
--   events       (source_ts)  per bulan    train_info  (source_ts) per bulan
--   audit_logs   (ts)         per bulan    telemetry_hourly (hour) per bulan  [tabel baru]
-- Data lama DIPINDAHKAN ke struktur baru. Pada data besar, jalankan di jendela maintenance.
--
-- Konsekuensi desain:
--  * Primary key menjadi (id, kolom_waktu) dan unique dedup menjadi (dedup_key, source_ts),
--    karena constraint unik pada tabel berpartisi wajib memuat kolom partisi. dedup_key sudah
--    mengandung source_ts, jadi aturan dedup tidak berubah.
--  * Foreign key raw_id → raw_records dihapus (PostgreSQL tidak mendukung FK ke kunci tanpa kolom
--    partisi secara praktis). raw_id tetap disimpan sebagai rujukan.
--  * Tiap tabel punya partisi DEFAULT sebagai jaring pengaman; job maintenance melaporkan isinya.
--  * Partisi baru dibuat & partisi lama dihapus oleh job maintenance (src/maintenance), bukan di sini.

-- ---------- fungsi bantu (dipakai juga oleh job maintenance) ----------

CREATE OR REPLACE FUNCTION mw_partition_bounds(gran text, at timestamptz, OUT p_start timestamptz, OUT p_end timestamptz)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF gran = 'day' THEN
    p_start := date_trunc('day', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    p_end := p_start + interval '1 day';
  ELSIF gran = 'month' THEN
    p_start := date_trunc('month', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    p_end := (date_trunc('month', at AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
  ELSE
    RAISE EXCEPTION 'granularity tidak dikenal: %', gran;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION mw_partition_name(base text, gran text, p_start timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT base || '_p' || to_char(p_start AT TIME ZONE 'UTC', CASE WHEN gran = 'day' THEN 'YYYYMMDD' ELSE 'YYYYMM' END)
$$;

-- Buat partisi untuk rentang [from_ts, to_ts]. Mengembalikan jumlah partisi baru.
CREATE OR REPLACE FUNCTION mw_ensure_partitions(parent text, base text, gran text, from_ts timestamptz, to_ts timestamptz)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  cur timestamptz := from_ts;
  b record;
  pname text;
  created integer := 0;
BEGIN
  WHILE cur <= to_ts LOOP
    SELECT * INTO b FROM mw_partition_bounds(gran, cur);
    pname := mw_partition_name(base, gran, b.p_start);
    IF to_regclass(pname) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', pname, parent, b.p_start, b.p_end);
      created := created + 1;
    END IF;
    cur := b.p_end;
  END LOOP;
  RETURN created;
END $$;

-- Hapus partisi yang seluruh rentangnya lebih tua dari cutoff. Mengembalikan nama partisi yang dihapus.
CREATE OR REPLACE FUNCTION mw_drop_partitions_before(parent text, base text, gran text, cutoff timestamptz)
RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  child text;
  suffix text;
  p_start timestamptz;
  p_end timestamptz;
BEGIN
  FOR child IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = parent
  LOOP
    suffix := substring(child FROM '^' || base || '_p(\d{6,8})$');
    CONTINUE WHEN suffix IS NULL; -- partisi default / nama lain tidak disentuh
    IF gran = 'day' AND length(suffix) = 8 THEN
      p_start := (to_date(suffix, 'YYYYMMDD')::timestamp) AT TIME ZONE 'UTC';
      p_end := p_start + interval '1 day';
    ELSIF gran = 'month' AND length(suffix) = 6 THEN
      p_start := (to_date(suffix || '01', 'YYYYMMDD')::timestamp) AT TIME ZONE 'UTC';
      p_end := ((to_date(suffix || '01', 'YYYYMMDD') + interval '1 month')::timestamp) AT TIME ZONE 'UTC';
    ELSE
      CONTINUE;
    END IF;
    IF p_end <= cutoff THEN
      EXECUTE format('DROP TABLE %I', child);
      RETURN NEXT child;
    END IF;
  END LOOP;
END $$;

-- Ubah tabel biasa menjadi tabel berpartisi, memindahkan seluruh datanya.
CREATE OR REPLACE FUNCTION mw_convert_to_partitioned(tbl text, col text, gran text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  tmp text := tbl || '_new';
  seq text := pg_get_serial_sequence(tbl, 'id');
  mn timestamptz;
  mx timestamptz;
  ahead interval := CASE WHEN gran = 'day' THEN interval '7 days' ELSE interval '2 months' END;
BEGIN
  EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE) PARTITION BY RANGE (%I)', tmp, tbl, col);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (id, %I)', tmp, tbl || '_pk', col);
  EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', tbl || '_default', tmp);

  EXECUTE format('SELECT min(%I), max(%I) FROM %I', col, col, tbl) INTO mn, mx;
  PERFORM mw_ensure_partitions(tmp, tbl, gran,
    LEAST(COALESCE(mn, now()), now() - interval '8 days'),
    GREATEST(COALESCE(mx, now()), now()) + ahead);

  EXECUTE format('INSERT INTO %I SELECT * FROM %I', tmp, tbl);

  IF seq IS NOT NULL THEN EXECUTE format('ALTER SEQUENCE %s OWNED BY NONE', seq); END IF;
  EXECUTE format('DROP TABLE %I CASCADE', tbl);
  EXECUTE format('ALTER TABLE %I RENAME TO %I', tmp, tbl);
  IF seq IS NOT NULL THEN EXECUTE format('ALTER SEQUENCE %s OWNED BY %I.id', seq, tbl); END IF;
END $$;

-- ---------- konversi (raw_records dulu: CASCADE menghapus FK dari tabel lain) ----------

SELECT mw_convert_to_partitioned('raw_records', 'source_ts', 'day');
CREATE UNIQUE INDEX IF NOT EXISTS raw_records_dedup_uniq ON raw_records (dedup_key, source_ts);
CREATE INDEX IF NOT EXISTS idx_raw_source_ts ON raw_records (source, source_ts DESC);

SELECT mw_convert_to_partitioned('telemetry', 'source_ts', 'day');
CREATE INDEX IF NOT EXISTS idx_tel_asset_metric_ts ON telemetry (asset_id, metric, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tel_station_ts ON telemetry (station, source_ts DESC);

SELECT mw_convert_to_partitioned('events', 'source_ts', 'month');
CREATE INDEX IF NOT EXISTS idx_evt_station_ts ON events (station, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_evt_severity_ts ON events (severity, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_evt_alarm_key_ts ON events (alarm_key, source_ts DESC) WHERE alarm_key IS NOT NULL;

SELECT mw_convert_to_partitioned('train_info', 'source_ts', 'month');
CREATE INDEX IF NOT EXISTS idx_train_station_ts ON train_info (station, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_train_station_ref_ts ON train_info (station, ref_id, source_ts DESC);

SELECT mw_convert_to_partitioned('audit_logs', 'ts', 'month');
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs (ts DESC);
-- audit tetap append-only untuk UPDATE/DELETE baris. Retensi menghapus partisi utuh (DROP), hanya
-- lewat job maintenance dan hanya bila RETENTION_AUDIT_DAYS > 0.
DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_modify();

-- ---------- agregat telemetri per jam (untuk tren jangka panjang) ----------

CREATE TABLE IF NOT EXISTS telemetry_hourly (
  source     text        NOT NULL,
  station    text        NOT NULL,
  asset_id   text        NOT NULL,
  metric     text        NOT NULL,
  unit       text,
  hour       timestamptz NOT NULL,
  n          integer     NOT NULL,
  avg_num    double precision,
  min_num    double precision,
  max_num    double precision,
  last_num   double precision,
  last_text  text,
  last_ts    timestamptz NOT NULL,
  PRIMARY KEY (asset_id, metric, hour)
) PARTITION BY RANGE (hour);
CREATE TABLE IF NOT EXISTS telemetry_hourly_default PARTITION OF telemetry_hourly DEFAULT;
SELECT mw_ensure_partitions('telemetry_hourly', 'telemetry_hourly', 'month', now() - interval '1 month', now() + interval '2 months');
CREATE INDEX IF NOT EXISTS idx_tel_hourly_station_hour ON telemetry_hourly (station, hour DESC);

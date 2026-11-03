-- 002_alarm_key_and_board.sql — Fase 3
-- 1. events.alarm_key: memasangkan alarm raise ↔ clear (mis. linkDown ↔ linkUp untuk port yang sama),
--    sehingga "alarm yang masih aktif" bisa dihitung dari event terakhir per alarm_key.
-- 2. train_info.status & ref_id: status mentah dari PIDC (ON_TIME/DELAYED/ARRIVED/DEPARTED/DISRUPTION_*)
--    dan ID perjalanan / gangguan, untuk menyusun papan kedatangan terkini per stasiun & peron.

ALTER TABLE events ADD COLUMN IF NOT EXISTS alarm_key text;
CREATE INDEX IF NOT EXISTS idx_evt_alarm_key_ts ON events (alarm_key, source_ts DESC) WHERE alarm_key IS NOT NULL;

ALTER TABLE train_info ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE train_info ADD COLUMN IF NOT EXISTS ref_id text;
CREATE INDEX IF NOT EXISTS idx_train_station_ref_ts ON train_info (station, ref_id, source_ts DESC);

# MRT Middleware Integration Service

Middleware integrasi **read-only** dari Facility SCADA (OPC UA), DTS/Telecommunication NMS, dan PIDS/PIDC Server
ke canonical model di PostgreSQL. Data didistribusikan lewat REST API dan WebSocket dengan kontrol role, scope,
dan audit log, plus UI dashboard monitoring.

```
Sumber (read-only) ──> Konektor ──> Pipeline ──> PostgreSQL
                                     │              │
                                     └─ publish ─> REST API / WebSocket ──> UI React (role + scope + audit)
```

## Tech stack

| Bagian | Stack |
| --- | --- |
| `server/` | Node.js 20+, Express, JavaScript (CommonJS + JSDoc), `ws`, `node-opcua`, `pg`, `zod`, `pino`, `prom-client` |
| `web/` | React 18, MUI 6, React Router, Vite |
| Database | PostgreSQL 15+ |

## Menjalankan secara lokal

```bash
# 1. Database
docker compose up -d

# 2. Server
cd server
npm install
cp .env.example .env
cp config/sources.example.json config/sources.json
npm run migrate
npm run mappings:import                                # mapping tag SCADA
npm run mappings:import -- data/nms-mappings.csv nms   # mapping perangkat NMS
npm run db:maintain        # buat partisi awal (server juga menjalankannya otomatis)
npm run sim:all            # terminal 1: simulator SCADA + NMS + PIDC sekaligus
npm run dev                # terminal 2: middleware di :8080

# buat API key untuk login UI
npm run client:create -- occ-operator operator "scada:*,nms:*,pids:*"

# 3. UI (terminal 3)
cd web
npm install
npm run dev                # http://localhost:5173 — /api dan /ws diteruskan ke :8080
```

Masuk ke UI dengan API key dari langkah `client:create`. Untuk login dengan akun Microsoft, isi variabel `AZURE_AD_*`
di `.env` (lihat [docs/azure-ad-setup.md](docs/azure-ad-setup.md)), atau uji dulu dengan mock lokal `npm run dev:aad-mock`.

### Produksi: satu proses

```bash
cd web && npm run build                 # hasil di web/dist
# di server/.env:  WEB_DIST_DIR=../web/dist
cd server && npm start                  # UI + API + WebSocket di :8080
```

## Struktur

```
server/
  src/
    index.js               bootstrap & graceful shutdown
    config.js  logger.js
    core/                  types (JSDoc), backoff
    connectors/            base (reconnect loop), opcua, http-poll, webhook, syslog, registry
    parsers/               scada-opcua, nms-generic-json, nms-syslog, pids-generic-json
    pipeline/              dedup, mapper, validate, pipeline
    storage/               pool, repository (semua query konsumen difilter scope)
    distribution/          WebSocket hub
    api/                   app, auth (API key, role, scope), audit, routes
    monitoring/            Prometheus metrics
  scripts/                 migrate, create-client, opcua-simulator
  migrations/001_init.sql
  config/sources.example.json
web/
  src/
    main.jsx               router & provider
    theme.js               token warna & tipografi MUI
    api.js  format.js
    auth/AuthContext.jsx   login API key, role, scope (GET /api/v1/me)
    live/LiveContext.jsx   satu koneksi WebSocket bersama + reconnect
    hooks/useApi.js
    components/            Layout, LineMap (status sumber), Sparkline, komponen umum
    pages/                 Login, Overview, Telemetry, Events, TrainInfo, Connectors
```

## Halaman UI

| Halaman | Isi | Role |
| --- | --- | --- |
| Ringkasan | Jumlah alarm aktif per severity, event terbaru, nilai terkini per stasiun | viewer |
| Telemetri | Nilai terakhir per aset + riwayat (grafik & tabel) saat baris dipilih | viewer |
| Event & alarm | Filter severity, status, kategori, sumber, stasiun; baris baru masuk live | viewer |
| Info kereta | Kedatangan, keberangkatan, keterlambatan, gangguan dari PIDS | viewer |
| Konektor | Status, data terakhir, percobaan ulang, error terakhir | operator |

Strip jalur di bagian atas menampilkan status tiap sistem sumber (dari `/ready`) dan status koneksi live.
API key disimpan di `sessionStorage`, jadi hilang saat tab ditutup.

## API (`/api/v1`, header `X-API-Key`)

Dokumentasi interface untuk konsumen (dibangkitkan dari skema zod yang sama dengan validasi, jadi selalu sinkron dengan kode):

| URL | Isi |
| --- | --- |
| `/docs` | Swagger UI: semua endpoint, parameter, skema respons, tombol *Try it out* |
| `/openapi.json` | Spesifikasi OpenAPI 3 (untuk generator klien) |
| `/docs/asyncapi.yaml` | Spesifikasi AsyncAPI protokol WebSocket `/ws` |
| [docs/data-dictionary.md](docs/data-dictionary.md) | Kamus data: arti field, severity, kode stasiun, contoh metric, batasan |

Rate limit: `RATE_LIMIT_PER_CLIENT` (default 600/menit) dan `RATE_LIMIT_PER_IP` (1.200/menit). Melewati batas → 429
dengan header `Retry-After`. Batas berlaku per instance. Bila middleware di belakang reverse proxy, set `TRUST_PROXY`
supaya IP klien di audit dan rate limit benar.

| Method | Path | Role | Keterangan |
| --- | --- | --- | --- |
| GET | `/auth/config` | publik | Konfigurasi login UI (SSO aktif?, tenant, client ID, scope API) |
| GET | `/me` | viewer | Nama, role, scope, jenis autentikasi, kedaluwarsa token |
| GET/PUT/DELETE | `/sso-mappings` | admin | Mapping App Role / grup Azure AD → role + scope |
| GET | `/telemetry` | viewer | Filter `source, station, assetId, metric, from, to, limit` |
| GET | `/telemetry/latest` | viewer | Nilai terakhir per aset/metric (24 jam terakhir) |
| GET | `/telemetry/hourly` | viewer | Agregat per jam (avg/min/max/terakhir) untuk tren jangka panjang |
| GET | `/events` | viewer | Filter `source, station, severity, state, category (boleh dipisah koma), from, to, limit` |
| GET | `/events/active` | viewer | Alarm yang masih aktif (event terakhir per `alarm_key` = active). Filter `source, station, severity` |
| GET | `/train-info` | viewer | Riwayat pesan PIDS. Filter `station, platform, type, from, to, limit` |
| GET | `/train-info/board` | viewer | Papan terkini: kereta berikutnya per stasiun & peron + gangguan aktif. Filter `station, perPlatform` |
| GET | `/connectors` | operator | Status konektor |
| GET/PUT | `/mappings` | admin | Kelola `tag_mappings` (konfigurasi internal middleware) |

Tanpa auth: `/health`, `/ready`, `/metrics` — batasi aksesnya di level jaringan/reverse proxy.

WebSocket `ws://<host>/ws`:

```json
{"type":"auth","token":"<access token Azure AD atau API key>"}
{"type":"subscribe","channels":["telemetry","event","train_info"],"stations":["LBB"]}
```

Untuk token SSO, server mengirim `{"type":"auth_expiring"}` 2 menit sebelum token habis. Klien membalas
`{"type":"auth","token":"<token baru>"}` di koneksi yang sama. Kalau tidak dibalas, koneksi ditutup dengan kode `4401`.

## Autentikasi

| Untuk | Cara | Header |
| --- | --- | --- |
| Pengguna (dashboard) | **SSO Azure AD / Microsoft Entra ID** — login akun Microsoft MRT di UI (MSAL) | `Authorization: Bearer <access token>` |
| Aplikasi / service | API key (`npm run client:create -- <nama> <role> <scope> [hari]`), dengan masa berlaku | `X-API-Key: <key>` |
| Aplikasi (opsional) | Token aplikasi Azure AD (client credentials + App Role), bila `AZURE_AD_ALLOW_APP_TOKENS=true` | `Authorization: Bearer <token>` |

- Role & scope pengguna SSO berasal dari **App Role** Azure AD yang dipetakan di tabel `sso_role_mappings`
  (`npm run sso:mapping -- list|set|disable|remove`, atau API admin `/api/v1/sso-mappings`).
- Pengguna tanpa App Role yang terpetakan ditolak dengan 403.
- Semua akses, termasuk yang ditolak beserta alasannya, tercatat di `audit_logs` dengan `auth_type` `sso` atau `api_key`.
- Panduan lengkap untuk tim TI (app registration, App Role, konfigurasi, mock lokal, troubleshooting):
  **[docs/azure-ad-setup.md](docs/azure-ad-setup.md)**.
- Endpoint publik `GET /api/v1/auth/config` memberi UI konfigurasi login (tenant & client ID, tanpa rahasia).
  Dengan begitu satu build UI bisa dipakai di semua lingkungan.

## Partisi & retensi data

Migrasi `004` mengubah tabel besar menjadi tabel berpartisi berdasarkan waktu (batas UTC). Data lama ikut dipindahkan.
Pada data besar, jalankan saat jendela maintenance.

| Tabel | Partisi | Retensi default (env) |
| --- | --- | --- |
| `raw_records` | per hari | 30 hari (`RETENTION_RAW_DAYS`) |
| `telemetry` | per hari | 90 hari (`RETENTION_TELEMETRY_DAYS`) |
| `telemetry_hourly` (agregat) | per bulan | 730 hari (`RETENTION_TELEMETRY_HOURLY_DAYS`) |
| `events` | per bulan | 730 hari (`RETENTION_EVENTS_DAYS`) |
| `train_info` | per bulan | 365 hari (`RETENTION_TRAIN_INFO_DAYS`) |
| `audit_logs` | per bulan | **tidak dihapus** (`RETENTION_AUDIT_DAYS=0`; isi sesuai kebijakan keamanan informasi, min. 30) |

Job maintenance berjalan otomatis di server tiap `MAINTENANCE_INTERVAL_MIN` (default 60 menit), atau manual dengan
`npm run db:maintain`. Tugasnya:
1. Membuat partisi ke depan (7 hari / 2 bulan) dan ke belakang (8 hari / 1 bulan), untuk data yang terlambat hingga 7 hari.
2. Menghitung agregat telemetri per jam untuk 3 jam lengkap terakhir.
3. Menghapus partisi yang seluruh rentangnya melewati masa retensi. Penghapusan memakai `DROP` partisi: instan, tanpa bloat.
4. Melaporkan baris yang jatuh ke partisi `*_default` (seharusnya 0).

Catatan:
- Partisi bulanan dihapus setelah *seluruh* bulannya lewat, jadi retensi efektif bisa lebih lama hingga ±1 bulan.
- Advisory lock mencegah dua instance menjalankan maintenance bersamaan.
- Unique dedup menjadi `(dedup_key, source_ts)` dan FK `raw_id` dihapus. Keduanya konsekuensi dari tabel berpartisi.

## Monitoring & alerting

Metric Prometheus di `/metrics`, termasuk:
- `mrt_mw_connector_up` dan `mrt_mw_connector_last_record_age_seconds`
- `mrt_mw_queue_depth` dan `mrt_mw_pipeline_seconds`
- `mrt_mw_records_rejected_total` dan `mrt_mw_records_dropped_total`
- `mrt_mw_db_up` dan `mrt_mw_maintenance_last_success_timestamp_seconds`
- `mrt_mw_default_partition_rows`, `mrt_mw_auth_failures_total`, `mrt_mw_rate_limited_total`

| File | Isi |
| --- | --- |
| `ops/prometheus/alerts.yml` | 15 aturan alert: middleware/DB mati, konektor putus, feed macet, record ditolak/dibuang, latency, maintenance, partisi default, disk, lonjakan 401 |
| `ops/prometheus/alerts.test.yml` | Uji unit aturan alert (`promtool test rules`) |
| `ops/prometheus/prometheus.yml` | Konfigurasi scrape |
| `ops/alertmanager/alertmanager.yml` | Rute notifikasi: email, Teams opsional. Critical dikirim lebih cepat; alert turunan diredam saat middleware/DB mati |
| [docs/runbook.md](docs/runbook.md) | Langkah penanganan per alert: arti → cek cepat → tindakan → eskalasi |

```bash
docker compose --profile monitoring up -d     # Prometheus :9090 + Alertmanager :9093
promtool check rules ops/prometheus/alerts.yml && promtool test rules ops/prometheus/alerts.test.yml
```

Isi alamat SMTP/penerima di `alertmanager.yml` sebelum dipakai. Ambang alert adalah titik awal; sesuaikan dengan tim
operasi setelah melihat pola data nyata.

## Scope

Format `source:station`, wildcard `*`. Contoh: `scada:*`, `pids:LBB`, `*:*`.
Semua query dan pesan WebSocket otomatis difilter scope klien; permintaan eksplisit di luar scope → `403`.

## Prinsip read-only

- **OPC UA**: hanya `read` dan `subscribe` — tidak ada `write`, `call`, `addNodes`, `deleteNodes`.
  Lapisan kedua: pakai user OPC UA dengan role read-only di server SCADA.
- **HTTP poll**: hanya `GET`.
- **Webhook / Syslog**: pasif, hanya menerima.
- Tidak ada endpoint middleware maupun tombol UI yang meneruskan perintah ke sistem sumber.

## Menambah sumber / protokol

1. Tambah konektor di `server/src/connectors/` (extend `BaseConnector`, implement `connectOnce()` + `disconnect()`,
   panggil `this.emitRecord(...)` dan `this.fail(err)`), daftarkan di `registry.js`.
2. Tambah parser di `server/src/parsers/index.js` yang mengembalikan array DraftRecord.
3. Tambah entri di `config/sources.json`.

Konektor yang tersedia: `opcua`, `http-poll`, `webhook`, `syslog`, `snmp-trap`, `websocket-client`.

## Katalog tag Facility SCADA (dummy realistis)

Sebelum daftar tag resmi dari tim/vendor SCADA tersedia, middleware memakai katalog dummy
`server/data/scada-tags.csv`. Isinya 880 tag dari 13 stasiun Fase 1 (7 layang, 6 bawah tanah).

| Sistem | Kode | Aset per stasiun |
| --- | --- | --- |
| HVAC / ECS | `ECS` | AHU (2 layang, 4 bawah tanah); chiller (2, bawah tanah) |
| Ventilasi terowongan | `TVS` | Tunnel ventilation fan (2, bawah tanah) |
| Lingkungan | `ENV` | Suhu peron & concourse, kelembapan, CO2 (bawah tanah) |
| Pintu peron | `PSD` / `APG` | 2 sisi peron (PSD bawah tanah, APG layang) |
| Eskalator & lift | `VTS` | Eskalator (6 layang, 8 bawah tanah), lift (2) |
| Daya LV | `PWR` | Panel Electric Room: kWh, kW, tegangan, faktor daya, incomer trip |
| Drainase | `DRN` | Sump pit: level, pompa, high level (bawah tanah) |
| Air bersih | `PLB` | Level tangki |
| Fire alarm | `FAS` | Fire alarm, panel fault |
| Penerangan | `LTG` | Penerangan peron |

Kolom katalog: `node_id, station_code, station_name, station_type, system, asset_code, asset_id, metric_tag,
metric, data_type, unit, kind, severity, normal_min, normal_max, sim, description`.
`kind` = `telemetry` (nilai), `event` (perubahan status), atau `alarm` (boolean aktif/normal, dengan `severity`).

**Yang asumsi** dan harus dicek ulang ke vendor: kode stasiun 3 huruf, format nodeId (`ns=2;s=STASIUN.SISTEM.ASET.METRIC`),
jumlah aset per stasiun, nama metric, rentang normal, dan severity alarm.

```bash
npm run tags:generate        # tulis ulang data/scada-tags.csv dari scripts/generate-scada-tags.js
npm run mappings:import      # impor katalog ke tabel tag_mappings
npm run sim:opcua            # simulator membaca katalog yang sama
SIM_ALARM_RATE=20 npm run sim:opcua   # alarm 20× lebih sering, untuk demo/uji
```

Simulator mengikuti jam operasi 05.00–24.00 WIB. Pintu peron buka 40 detik per kedatangan kereta, dengan headway
5 menit di jam sibuk dan 10 menit di luar jam sibuk. Suhu dan daya mengikuti siklus harian. Alarm muncul acak
2–15 menit lalu normal kembali, dan aset yang fault berhenti beroperasi.

Saat daftar tag vendor tiba: ubah ke format kolom yang sama (minimal `node_id, station_code, asset_id, metric,
unit, kind, severity`), arahkan `nodesCsv` di `config/sources.json` ke file itu, lalu jalankan
`npm run mappings:import -- path/ke/file.csv scada`.

## Katalog & simulator DTS/NMS (dummy)

Katalog dibuat oleh `npm run nms:generate`:

| File | Isi |
| --- | --- |
| `data/nms-devices.csv` | 142 perangkat: core & access switch DTS, radio base station, CCTV NVR, PA controller, clock slave, PIDS display controller per stasiun, plus core router/switch, NMS server, TETRA switch di OCC. IP `10.20.<stasiun>.x`, hostname `LBB-CSW01` |
| `data/nms-traps.csv` | 24 jenis trap: linkDown/linkUp, coldStart, authenticationFailure (OID standar) + CPU, suhu, PSU, kipas, ring backbone, disk, carrier radio, clock sync, amplifier PA, display PIDS (OID dummy PEN 32473). Tiap alarm punya trap clear-nya |
| `data/nms-mappings.csv` | IP & hostname → `asset_id` + stasiun, untuk `mappings:import ... nms` |

`npm run sim:nms` mengirim **SNMP v2c trap** ke UDP 1162 dan **syslog RFC 5424** ke UDP 5514:
- Alarm acak sesuai tipe perangkat, aktif 1–20 menit lalu dikirim trap clear-nya.
- linkDown/linkUp disertai syslog `%LINK-3-UPDOWN`.
- Syslog rutin (login, sinkron NTP, konfigurasi disimpan, peringatan suhu) ±1 pesan per 3 detik.
- Trap membawa `snmpTrapAddress.0` dan `sysName.0`, seperti trap yang diteruskan NMS.

Konektor yang dipakai: `snmp-trap` (pasif, community dari env `NMS_SNMP_COMMUNITY`) dan `syslog`, dengan parser
`nms-snmp-trap` (membaca `data/nms-traps.csv`) dan `nms-syslog` (RFC 5424 & 3164). Raise dan clear dipasangkan
lewat `alarm_key = IP|trap|instans` (mis. `10.20.1.11|link_down|12`).

## Katalog & simulator PIDS/PIDC (dummy)

`npm run pids:generate` menulis `data/pids-stations.csv`: urutan 13 stasiun, waktu tempuh kumulatif dari Lebak Bulus
(28 menit ke Bundaran HI), peron per arah (1 = arah Bundaran HI, 2 = arah Lebak Bulus), dan dwell.

`npm run sim:pids` menjalankan feed PIDC dummy:
- **WebSocket** `ws://localhost:8095/feed`: snapshot saat tersambung, lalu `arrival_update` / `disruption`, dan `heartbeat` tiap 15 detik.
- **REST** `GET /api/v1/arrivals?station=LBB` dan `GET /api/v1/disruptions`.
- Jam operasi 05.00–24.00 WIB, keberangkatan terakhir 23.30. Headway 5 menit di jam sibuk, 10 menit di luar itu.
- Sebagian perjalanan terlambat 1–10 menit. Gangguan acak 8–20 menit menambah keterlambatan.
- Per stasiun ada update perkiraan tiap 30 detik, lalu `ARRIVED` dan `DEPARTED`.

Konektor `websocket-client` (read-only, watchdog 60 detik) dengan parser `pids-pidc-feed`. ID perjalanan/gangguan
masuk ke `train_info.ref_id`, status mentah ke `train_info.status` (migrasi `002`).

Semua simulator sekaligus: `npm run sim:all`. Frekuensi alarm & gangguan: `SIM_ALARM_RATE=20 npm run sim:all`.

**Yang asumsi** (ganti setelah spesifikasi tim DTS & PIDC tersedia): protokol & format pesan, tipe dan jumlah perangkat,
rencana IP, OID enterprise, severity trap, waktu tempuh, nomor peron, headway, format nomor perjalanan.

## Mapping tag

Bila `tag_mappings` belum diisi, parser SCADA menebak `station/asset/metric` dari pola nodeId
`STATION.SYSTEM.ASSET.METRIC` (mis. `ns=1;s=LBB.HVAC.AHU01.Temperature`). Isi mapping untuk nodeId yang tidak mengikuti pola:

```bash
curl -X PUT -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  http://localhost:8080/api/v1/mappings \
  -d '{"source":"scada","sourceKey":"ns=2;i=1043","assetId":"LBB-AHU-01","station":"LBB","metric":"supply_temp","unit":"degC"}'
```

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
npm run sim:opcua          # terminal 1: simulator SCADA OPC UA
npm run dev                # terminal 2: middleware di :8080

# buat API key untuk login UI
npm run client:create -- occ-operator operator "scada:*,nms:*,pids:*"

# 3. UI (terminal 3)
cd web
npm install
npm run dev                # http://localhost:5173 — /api dan /ws diteruskan ke :8080
```

Masuk ke UI dengan API key dari langkah `client:create`.

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

| Method | Path | Role | Keterangan |
| --- | --- | --- | --- |
| GET | `/me` | viewer | Nama, role, dan scope klien |
| GET | `/telemetry` | viewer | Filter `source, station, assetId, metric, from, to, limit` |
| GET | `/telemetry/latest` | viewer | Nilai terakhir per aset/metric (24 jam terakhir) |
| GET | `/events` | viewer | Filter `source, station, severity, state, category, from, to, limit` |
| GET | `/train-info` | viewer | Filter `station, platform, type, from, to, limit` |
| GET | `/connectors` | operator | Status konektor |
| GET/PUT | `/mappings` | admin | Kelola `tag_mappings` (konfigurasi internal middleware) |

Tanpa auth: `/health`, `/ready`, `/metrics` — batasi aksesnya di level jaringan/reverse proxy.

WebSocket `ws://<host>/ws`:

```json
{"type":"auth","apiKey":"<key>"}
{"type":"subscribe","channels":["telemetry","event","train_info"],"stations":["LBB"]}
```

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

Kandidat berikutnya: `snmp-trap` (NMS), `websocket-client` (PIDS) — setelah spesifikasi interface DTS/NMS dan PIDC tersedia.

## Mapping tag

Bila `tag_mappings` belum diisi, parser SCADA menebak `station/asset/metric` dari pola nodeId
`STATION.SYSTEM.ASSET.METRIC` (mis. `ns=1;s=LBB.HVAC.AHU01.Temperature`). Isi mapping untuk nodeId yang tidak mengikuti pola:

```bash
curl -X PUT -H "X-API-Key: <admin-key>" -H "Content-Type: application/json" \
  http://localhost:8080/api/v1/mappings \
  -d '{"source":"scada","sourceKey":"ns=2;i=1043","assetId":"LBB-AHU-01","station":"LBB","metric":"supply_temp","unit":"degC"}'
```

'use strict';

/**
 * Simulator PIDC Server (DUMMY): feed perkiraan kedatangan kereta per stasiun, berdasarkan data/pids-stations.csv.
 *
 * Interface dummy:
 *   WebSocket  ws://localhost:8095/feed          snapshot saat tersambung, lalu update incremental + heartbeat
 *   REST       GET /api/v1/arrivals?station=LBB  perkiraan kedatangan saat ini
 *              GET /api/v1/disruptions           gangguan aktif
 *   Auth       header Authorization: Bearer <PIDS_API_TOKEN> bila env PIDS_API_TOKEN diisi
 *
 * Perilaku:
 *  - Jam operasi 05.00–24.00 WIB, keberangkatan terakhir dari terminal 23.30.
 *  - Headway 5 menit (07–09 & 17–19 WIB) dan 10 menit di luar jam sibuk, dari Lebak Bulus (T-ganjil, arah BHI)
 *    dan Bundaran HI (T-genap, arah LBB).
 *  - Sebagian perjalanan terlambat 1–10 menit; gangguan acak (8–20 menit) menambah keterlambatan semua perjalanan.
 *  - Per stasiun: update perkiraan tiap 30 detik selama ≤15 menit sebelum tiba, lalu ARRIVED dan DEPARTED.
 *
 * Env: PIDS_PORT (8095), PIDS_API_TOKEN (kosong = tanpa auth), SIM_ALARM_RATE (pengali frekuensi gangguan)
 */

const http = require('node:http');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { readCsvFile } = require('../src/core/csv');

const PORT = Number(process.env.PIDS_PORT || 8095);
const TOKEN = process.env.PIDS_API_TOKEN || '';
const RATE = Number(process.env.SIM_ALARM_RATE || 1);

const stations = readCsvFile(path.join(__dirname, '..', 'data', 'pids-stations.csv')).map((s) => ({
  ...s,
  offset: Number(s.offset_min) * 60_000,
  dwell: Number(s.dwell_s) * 1000,
}));
const FIRST = stations[0];
const LAST = stations.at(-1);
const END_TO_END = LAST.offset;

// ---------- waktu WIB ----------
const WIB = 7 * 3600_000;
const wibMidnight = (t = Date.now()) => Math.floor((t + WIB) / 86_400_000) * 86_400_000 - WIB;
const wibHourOf = (t) => (((t + WIB) % 86_400_000) / 3_600_000);
const headwayAt = (t) => {
  const h = wibHourOf(t);
  return (h >= 7 && h < 9) || (h >= 17 && h < 19) ? 5 * 60_000 : 10 * 60_000;
};

/** Daftar keberangkatan dari terminal untuk hari layanan yang memuat waktu t. */
function departuresFor(t) {
  const day = wibMidnight(t);
  const list = [];
  let d = day + 5 * 3_600_000;
  const last = day + 23.5 * 3_600_000;
  while (d <= last) {
    list.push(d);
    d += headwayAt(d);
  }
  return list;
}

/** Keterlambatan dasar per perjalanan, deterministik dari nomor perjalanan. */
function baseDelay(tripNo) {
  const h = createHash('sha1').update(tripNo).digest();
  const r = h[0] / 255;
  if (r < 0.8) return 0;
  if (r < 0.95) return (60 + (h[1] / 255) * 180) * 1000;
  return (300 + (h[1] / 255) * 300) * 1000;
}

// ---------- gangguan ----------
/** @type {Map<string, {id:string, stations:string[], text:string, severity:string, extra:number, startedAt:number, until:number}>} */
const disruptions = new Map();
let dsrSeq = 0;
const TEMPLATES = [
  (a, b) => [`Gangguan persinyalan antara ${a.station_name} dan ${b.station_name}. Perjalanan kereta melambat.`, 'major'],
  (a) => [`Penanganan gangguan teknis kereta di Stasiun ${a.station_name}.`, 'major'],
  (a) => [`Penanganan penumpang sakit di Stasiun ${a.station_name}. Kereta tertahan sementara.`, 'minor'],
  (a, b) => [`Pemeriksaan jalur antara ${a.station_name} dan ${b.station_name}.`, 'minor'],
];

function extraDelay() {
  let e = 0;
  for (const d of disruptions.values()) e += d.extra;
  return e;
}

// ---------- feed ----------
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/feed' });

const authOk = (req) => !TOKEN || req.headers.authorization === `Bearer ${TOKEN}`;

/** Prediksi terkini per (stasiun, perjalanan) untuk snapshot & REST. */
const current = new Map();
const lastEmit = new Map();
let sent = 0;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  sent += 1;
}

function arrivalMessage(trip, st, status, sched, est) {
  const delay = Math.round((est - sched) / 1000);
  const msg = {
    type: 'arrival_update',
    messageId: randomUUID(),
    generatedAt: new Date().toISOString(),
    station: st.station_code,
    stationName: st.station_name,
    platform: trip.dir === 'NB' ? st.platform_nb : st.platform_sb,
    tripNo: trip.tripNo,
    direction: trip.dir,
    destination: trip.dir === 'NB' ? LAST.station_name : FIRST.station_name,
    scheduledArrival: new Date(sched).toISOString(),
    estimatedArrival: new Date(est).toISOString(),
    delaySeconds: delay,
    status: status === 'PREDICTED' ? (delay >= 60 ? 'DELAYED' : 'ON_TIME') : status,
  };
  const key = `${st.station_code}|${trip.tripNo}`;
  if (status === 'DEPARTED') current.delete(key);
  else current.set(key, msg);
  return msg;
}

function disruptionMessage(d, active) {
  return {
    type: 'disruption',
    messageId: randomUUID(),
    generatedAt: new Date().toISOString(),
    disruptionId: d.id,
    stations: d.stations,
    severity: d.severity,
    text: d.text,
    active,
    startedAt: new Date(d.startedAt).toISOString(),
  };
}

function tick() {
  const now = Date.now();

  // gangguan: mulai / selesai
  for (const [id, d] of disruptions) {
    if (d.until <= now) {
      disruptions.delete(id);
      broadcast(disruptionMessage(d, false));
    }
  }
  const h = wibHourOf(now);
  if (h >= 5 && h < 23.5 && Math.random() < (5 / 2700) * RATE && disruptions.size < 2) {
    const i = Math.floor(Math.random() * (stations.length - 1));
    const [text, severity] = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)](stations[i], stations[i + 1]);
    dsrSeq += 1;
    const d = {
      id: `DSR-${String(dsrSeq).padStart(4, '0')}`,
      stations: [stations[i].station_code, stations[i + 1].station_code],
      text,
      severity,
      extra: (180 + Math.random() * 300) * 1000,
      startedAt: now,
      until: now + (8 + Math.random() * 12) * 60_000,
    };
    disruptions.set(d.id, d);
    broadcast(disruptionMessage(d, true));
  }

  // perjalanan yang relevan: berangkat dalam (now - 45 menit, now + 15 menit]
  const extra = extraDelay();
  const deps = departuresFor(now);
  deps.forEach((dep, k) => {
    if (dep > now + 15 * 60_000 || dep + END_TO_END + 15 * 60_000 < now) return;
    for (const dir of ['NB', 'SB']) {
      const trip = { dir, tripNo: `T${1000 + 2 * k + (dir === 'NB' ? 1 : 2)}` };
      const delay = baseDelay(trip.tripNo) + extra;
      for (const st of stations) {
        const offset = dir === 'NB' ? st.offset : END_TO_END - st.offset;
        const sched = dep + offset;
        const est = sched + delay;
        if (est > now + 15 * 60_000 || est + st.dwell + 60_000 < now) continue;

        const key = `${st.station_code}|${trip.tripNo}`;
        const prev = lastEmit.get(key) ?? { status: null, at: 0, est: 0 };
        let status = 'PREDICTED';
        if (now >= est + st.dwell) status = 'DEPARTED';
        else if (now >= est) status = 'ARRIVED';

        const changed = status !== prev.status || Math.abs(est - prev.est) >= 30_000;
        const periodic = status === 'PREDICTED' && now - prev.at >= 30_000;
        if (!changed && !periodic) continue;
        if (status === 'DEPARTED' && prev.status === null) continue; // jangan kirim departed tanpa riwayat
        lastEmit.set(key, { status, at: now, est });
        broadcast(arrivalMessage(trip, st, status, sched, est));
      }
    }
  });

  // bersihkan state lama
  for (const [key, v] of lastEmit) if (now - v.at > 60 * 60_000) lastEmit.delete(key);
}

wss.on('connection', (ws, req) => {
  if (!authOk(req)) {
    ws.close(4401, 'unauthorized');
    return;
  }
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      generatedAt: new Date().toISOString(),
      items: [...current.values(), ...[...disruptions.values()].map((d) => disruptionMessage(d, true))],
    }),
  );
  // Feed ini satu arah: pesan dari klien diabaikan
  ws.on('message', () => undefined);
});

setInterval(() => broadcast({ type: 'heartbeat', generatedAt: new Date().toISOString() }), 15_000);

app.use((req, res, next) => (authOk(req) ? next() : res.status(401).json({ error: 'unauthorized' })));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/v1/arrivals', (req, res) => {
  const st = String(req.query.station ?? '').toUpperCase();
  const items = [...current.values()].filter((m) => !st || m.station === st);
  items.sort((a, b) => a.estimatedArrival.localeCompare(b.estimatedArrival));
  res.json({ generatedAt: new Date().toISOString(), items });
});
app.get('/api/v1/disruptions', (_req, res) => {
  res.json({ generatedAt: new Date().toISOString(), items: [...disruptions.values()].map((d) => disruptionMessage(d, true)) });
});

server.listen(PORT, () => {
  tick();
  setInterval(tick, 5000);
  console.log(
    `PIDC simulator: ${stations.length} stasiun → ws://localhost:${PORT}/feed, http://localhost:${PORT}/api/v1/arrivals` +
      `${TOKEN ? ' (token wajib)' : ''}, gangguan ×${RATE}, jam WIB ${wibHourOf(Date.now()).toFixed(1)}`,
  );
});

setInterval(() => console.log(`[pids-sim] pesan terkirim ${sent}, prediksi aktif ${current.size}, gangguan aktif ${disruptions.size}`), 60_000);

'use strict';

/**
 * Simulator Facility SCADA (OPC UA Server) untuk pengembangan, berbasis katalog tag data/scada-tags.csv.
 * Endpoint: opc.tcp://localhost:4840/UA/MiddlewareSim
 *
 * Perilaku (kolom `sim` di katalog):
 *   analog          random walk di dalam normal_min–normal_max
 *   analog_daily    mengikuti siklus harian (puncak ±14.00 WIB) + noise
 *   analog_ophours  analog saat jam operasi, 0 di luar jam operasi
 *   run_ophours     true pada jam operasi (05.00–24.00 WIB), false bila aset sedang fault
 *   run_rare        biasanya false, sesekali true beberapa menit (mis. tunnel fan)
 *   enum_rare:A|B   biasanya A, sesekali B beberapa menit
 *   enum_cycle:A|B  bergantian A/B tiap 20–60 detik
 *   fixed:X         nilai tetap
 *   floor           lantai acak di normal_min–normal_max
 *   door:n          OPEN saat kereta berhenti (dwell 40 dtk) mengikuti headway; CLOSED di luar itu
 *   door_locked:n   kebalikan door:n
 *   counter         energi kumulatif (kWh), laju = kW di normal_min–normal_max
 *   sump/sump_pump  level sump naik perlahan; pompa menyala di 70% dan mati di 20%
 *   alarm           alarm acak, aktif 2–15 menit lalu normal kembali
 *   alarm_rare      seperti alarm, 10× lebih jarang
 *
 * Env: SIM_TAGS_CSV (default data/scada-tags.csv), SIM_ALARM_RATE (pengali frekuensi alarm, default 1),
 *      SIM_PORT (default 4840)
 * Semua variabel read-only (accessLevel CurrentRead).
 */

const path = require('node:path');
const { DataType, OPCUAServer, Variant, StatusCodes } = require('node-opcua');
const { readCsvFile } = require('../src/core/csv');

const CSV = path.resolve(process.env.SIM_TAGS_CSV || path.join(__dirname, '..', 'data', 'scada-tags.csv'));
const ALARM_RATE = Number(process.env.SIM_ALARM_RATE || 1);
const PORT = Number(process.env.SIM_PORT || 4840);
const ANALOG_PERIOD_S = 15; // nilai analog diperbarui ±tiap 15 detik per tag

const DATA_TYPES = { Double: DataType.Double, Boolean: DataType.Boolean, String: DataType.String, Int32: DataType.Int32 };

// ---------- waktu (WIB) ----------
const wibHour = (d = new Date()) => (d.getUTCHours() + 7 + d.getUTCMinutes() / 60) % 24;
const isOpHours = () => {
  const h = wibHour();
  return h >= 5 && h < 24;
};
const isPeak = () => {
  const h = wibHour();
  return (h >= 7 && h < 9) || (h >= 17 && h < 19);
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- state per aset (untuk kopling fault → running, sump → pompa) ----------
const assetState = new Map();
const asset = (key) => {
  if (!assetState.has(key)) assetState.set(key, { faults: 0, pumping: false, level: rand(20, 50) });
  return assetState.get(key);
};

/** Buat fungsi tick per tag. Mengembalikan nilai baru, atau undefined bila belum waktunya berubah. */
function makeBehaviour(tag, stationIndex) {
  const [profile, arg = ''] = tag.sim.split(':');
  const min = Number(tag.normal_min || 0);
  const max = Number(tag.normal_max || 1);
  const span = max - min || 1;
  const decimals = span < 2 ? 2 : 1;
  const assetKey = `${tag.station_code}.${tag.asset_code}`;
  let next = 0; // tick pertama selalu menghasilkan nilai awal
  let first = true;
  const due = (periodS) => {
    if (first) {
      first = false;
      next = Date.now() + rand(0, periodS * 1000); // sebar fase update berikutnya
      return true;
    }
    if (Date.now() < next) return false;
    next = Date.now() + rand(0.7, 1.3) * periodS * 1000;
    return true;
  };

  switch (profile) {
    case 'analog': {
      let v = rand(min + span * 0.3, max - span * 0.3);
      return () => {
        if (!due(ANALOG_PERIOD_S)) return undefined;
        v = clamp(v + rand(-0.05, 0.05) * span, min, max);
        return round(v, decimals);
      };
    }
    case 'analog_daily':
      return () => {
        if (!due(ANALOG_PERIOD_S)) return undefined;
        const day = 0.5 + 0.4 * Math.sin((2 * Math.PI * (wibHour() - 8)) / 24);
        return round(clamp(min + span * day + rand(-0.04, 0.04) * span, min - span * 0.1, max + span * 0.1), decimals);
      };
    case 'analog_ophours': {
      let v = rand(min, max);
      return () => {
        if (!due(ANALOG_PERIOD_S)) return undefined;
        if (!isOpHours() || asset(assetKey).faults > 0) return 0;
        v = clamp(v + rand(-0.05, 0.05) * span, min, max);
        return round(v, decimals);
      };
    }
    case 'run_ophours':
      return () => isOpHours() && asset(assetKey).faults === 0;
    case 'run_rare': {
      let until = 0;
      return () => {
        if (until < Date.now() && due(30) && Math.random() < 0.01) until = Date.now() + rand(3, 10) * 60_000;
        return until > Date.now();
      };
    }
    case 'enum_rare': {
      const [a, b] = arg.split('|');
      let until = 0;
      return () => {
        if (until < Date.now() && due(30) && Math.random() < 0.005) until = Date.now() + rand(5, 15) * 60_000;
        return until > Date.now() ? b : a;
      };
    }
    case 'enum_cycle': {
      const [a, b] = arg.split('|');
      let cur = a;
      return () => {
        if (!isOpHours()) return a;
        if (due(rand(20, 60))) cur = cur === a ? b : a;
        return cur;
      };
    }
    case 'fixed':
      return () => arg;
    case 'floor': {
      let f = min;
      return () => {
        if (isOpHours() && due(rand(30, 60))) f = Math.round(rand(min, max));
        return f;
      };
    }
    case 'door':
    case 'door_locked': {
      const side = Number(arg) || 1;
      // offset per stasiun & arah agar kereta tidak tiba serentak di semua stasiun
      const offsetS = stationIndex * 120 + (side === 1 ? 0 : 150);
      return () => {
        let open = false;
        if (isOpHours()) {
          const headwayS = isPeak() ? 300 : 600;
          const phase = (Math.floor(Date.now() / 1000) + offsetS) % headwayS;
          open = phase < 40;
        }
        if (profile === 'door') return open ? 'OPEN' : 'CLOSED';
        return !open;
      };
    }
    case 'counter': {
      let kwh = round(rand(2e6, 6e6), 1);
      let last = Date.now();
      return () => {
        if (!due(ANALOG_PERIOD_S)) return undefined;
        const now = Date.now();
        const day = 0.5 + 0.4 * Math.sin((2 * Math.PI * (wibHour() - 8)) / 24);
        kwh += ((min + span * day) * (now - last)) / 3_600_000;
        last = now;
        return round(kwh, 1);
      };
    }
    case 'sump': {
      const st = asset(assetKey);
      return () => {
        if (!due(ANALOG_PERIOD_S)) return undefined;
        if (st.pumping) {
          st.level -= rand(1.5, 2.5);
          if (st.level <= 20) st.pumping = false;
        } else {
          st.level += rand(0.1, 0.4);
          if (st.level >= 70) st.pumping = true;
        }
        st.level = clamp(st.level, 0, 100);
        return round(st.level, 1);
      };
    }
    case 'sump_pump':
      return () => asset(assetKey).pumping;
    case 'alarm':
    case 'alarm_rare': {
      // target: ±1 alarm baru per menit di seluruh katalog pada SIM_ALARM_RATE=1
      const p = (profile === 'alarm' ? 6.7e-4 : 6.7e-5) * ALARM_RATE;
      let until = 0;
      let active = false;
      return () => {
        const now = Date.now();
        if (active && now > until) {
          active = false;
          asset(assetKey).faults -= 1;
        } else if (!active && due(10) && Math.random() < p) {
          active = true;
          until = now + rand(2, 15) * 60_000;
          asset(assetKey).faults += 1;
        }
        return active;
      };
    }
    default:
      throw new Error(`Unknown sim profile "${tag.sim}" on ${tag.node_id}`);
  }
}

async function main() {
  const tags = readCsvFile(CSV);
  const stations = [...new Set(tags.map((t) => t.station_code))];

  const server = new OPCUAServer({
    port: PORT,
    resourcePath: '/UA/MiddlewareSim',
    buildInfo: { productName: 'MRT Facility SCADA Simulator', buildNumber: '2' },
  });
  await server.initialize();

  const { addressSpace } = server.engine;
  // ns=2 sesuai katalog (ns=1 dipakai server sendiri)
  const ns = addressSpace.registerNamespace('urn:mrt-jakarta:facility-scada:sim');
  const root = ns.addFolder(addressSpace.rootFolder.objects, { browseName: 'FacilitySCADA' });

  const folders = new Map();
  const folder = (parent, key, name) => {
    if (!folders.has(key)) folders.set(key, ns.addFolder(parent, { browseName: name }));
    return folders.get(key);
  };

  const sims = [];
  for (const tag of tags) {
    const fStation = folder(root, tag.station_code, `${tag.station_code} ${tag.station_name}`);
    const fSystem = folder(fStation, `${tag.station_code}.${tag.system}`, tag.system);
    const fAsset = folder(fSystem, `${tag.station_code}.${tag.system}.${tag.asset_code}`, tag.asset_code);
    const dataType = DATA_TYPES[tag.data_type];
    if (!dataType) throw new Error(`Unsupported data_type ${tag.data_type} on ${tag.node_id}`);

    const variable = ns.addVariable({
      componentOf: fAsset,
      nodeId: tag.node_id.replace(/^ns=\d+;/, ''),
      browseName: tag.metric_tag,
      description: tag.description,
      dataType,
      accessLevel: 'CurrentRead',
      userAccessLevel: 'CurrentRead',
      minimumSamplingInterval: 500,
    });
    sims.push({ tag, variable, dataType, tick: makeBehaviour(tag, stations.indexOf(tag.station_code)), last: undefined });
  }

  const step = () => {
    for (const s of sims) {
      const v = s.tick();
      if (v === undefined || v === s.last) continue;
      s.last = v;
      s.variable.setValueFromSource(new Variant({ dataType: s.dataType, value: v }), StatusCodes.Good, new Date());
    }
  };
  step();
  setInterval(step, 1000);

  await server.start();
  console.log(`OPC UA simulator: ${tags.length} tag, ${stations.length} stasiun → ${server.getEndpointUrl()}`);
  console.log(`Jam operasi saat ini: ${isOpHours() ? 'ya' : 'tidak'} (WIB ${wibHour().toFixed(1)}), alarm rate ×${ALARM_RATE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

/**
 * Generator katalog tag Facility SCADA (DUMMY REALISTIS) untuk MRT Jakarta Fase 1.
 *
 * Dasar yang dipakai (informasi publik):
 *  - 13 stasiun Lebak Bulus – Bundaran HI; 7 stasiun layang di selatan, 6 bawah tanah (Senayan – Bundaran HI).
 *  - Facility SCADA di OCC memonitor fasilitas stasiun, termasuk Platform Screen Door.
 *  - Distribusi daya 20 kV ke Electric Room (ER), turun ke 400 V untuk beban stasiun.
 *
 * Yang ASUMSI (ganti setelah daftar tag vendor tersedia):
 *  - Kode stasiun 3 huruf, format nodeId, jumlah aset per stasiun, nama metric, rentang normal, severity alarm.
 *
 * Output: data/scada-tags.csv
 * Pemakaian: npm run tags:generate
 */

const fs = require('node:fs');
const path = require('node:path');
const { toCsv } = require('../src/core/csv');

const NS = 'ns=2;s=';

/** Urut selatan → utara. type: elevated | underground */
const STATIONS = [
  ['LBB', 'Lebak Bulus', 'elevated'],
  ['FTM', 'Fatmawati', 'elevated'],
  ['CPR', 'Cipete Raya', 'elevated'],
  ['HJN', 'Haji Nawi', 'elevated'],
  ['BLA', 'Blok A', 'elevated'],
  ['BLM', 'Blok M', 'elevated'],
  ['ASN', 'ASEAN', 'elevated'],
  ['SNY', 'Senayan', 'underground'],
  ['IST', 'Istora', 'underground'],
  ['BNH', 'Bendungan Hilir', 'underground'],
  ['STB', 'Setiabudi', 'underground'],
  ['DKA', 'Dukuh Atas', 'underground'],
  ['BHI', 'Bundaran HI', 'underground'],
];

const COLUMNS = [
  'node_id',
  'station_code',
  'station_name',
  'station_type',
  'system',
  'asset_code',
  'asset_id',
  'metric_tag',
  'metric',
  'data_type',
  'unit',
  'kind',
  'severity',
  'normal_min',
  'normal_max',
  'sim',
  'description',
];

const pad = (n) => String(n).padStart(2, '0');

function build() {
  const rows = [];

  for (const [code, name, type] of STATIONS) {
    const ug = type === 'underground';

    /**
     * @param {string} system   kode sistem di nodeId (ECS, PSD, ESC, ...)
     * @param {string} asset    kode aset di nodeId (AHU01, ESC03, ...)
     * @param {string} assetKind kode aset untuk asset_id (AHU, ESC, ...)
     * @param {number|null} n   nomor aset
     */
    const add = (system, asset, assetKind, n, metricTag, metric, o) => {
      rows.push({
        node_id: `${NS}${code}.${system}.${asset}.${metricTag}`,
        station_code: code,
        station_name: name,
        station_type: type,
        system,
        asset_code: asset,
        asset_id: n === null ? `${code}-${assetKind}` : `${code}-${assetKind}-${pad(n)}`,
        metric_tag: metricTag,
        metric,
        data_type: o.dataType,
        unit: o.unit ?? '',
        kind: o.kind ?? 'telemetry',
        severity: o.severity ?? '',
        normal_min: o.min ?? '',
        normal_max: o.max ?? '',
        sim: o.sim,
        description: o.desc,
      });
    };

    // ---- ECS / HVAC: Air Handling Unit (concourse & platform) ----
    const ahuCount = ug ? 4 : 2;
    for (let i = 1; i <= ahuCount; i += 1) {
      const a = `AHU${pad(i)}`;
      add('ECS', a, 'AHU', i, 'Running', 'running', { dataType: 'Boolean', sim: 'run_ophours', desc: `AHU ${i} beroperasi` });
      add('ECS', a, 'AHU', i, 'SupplyTemp', 'supply_temp', { dataType: 'Double', unit: '°C', min: 13, max: 17, sim: 'analog_daily', desc: `Suhu udara suplai AHU ${i}` });
      add('ECS', a, 'AHU', i, 'ReturnTemp', 'return_temp', { dataType: 'Double', unit: '°C', min: 24, max: 28, sim: 'analog_daily', desc: `Suhu udara balik AHU ${i}` });
      add('ECS', a, 'AHU', i, 'FanSpeed', 'fan_speed', { dataType: 'Double', unit: '%', min: 55, max: 90, sim: 'analog_ophours', desc: `Kecepatan fan AHU ${i}` });
      add('ECS', a, 'AHU', i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'minor', sim: 'alarm', desc: `AHU ${i} trip/fault` });
    }

    // ---- ECS: Chiller (stasiun bawah tanah) ----
    if (ug) {
      for (let i = 1; i <= 2; i += 1) {
        const a = `CH${pad(i)}`;
        add('ECS', a, 'CH', i, 'Running', 'running', { dataType: 'Boolean', sim: 'run_ophours', desc: `Chiller ${i} beroperasi` });
        add('ECS', a, 'CH', i, 'ChwSupplyTemp', 'chw_supply_temp', { dataType: 'Double', unit: '°C', min: 6, max: 8, sim: 'analog', desc: `Suhu air dingin suplai chiller ${i}` });
        add('ECS', a, 'CH', i, 'Load', 'load', { dataType: 'Double', unit: '%', min: 40, max: 85, sim: 'analog_daily', desc: `Beban chiller ${i}` });
        add('ECS', a, 'CH', i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'major', sim: 'alarm', desc: `Chiller ${i} fault` });
      }
    }

    // ---- TVF: Tunnel Ventilation Fan (stasiun bawah tanah) ----
    if (ug) {
      for (let i = 1; i <= 2; i += 1) {
        const a = `TVF${pad(i)}`;
        add('TVS', a, 'TVF', i, 'Running', 'running', { dataType: 'Boolean', sim: 'run_rare', desc: `Tunnel ventilation fan ${i} beroperasi` });
        add('TVS', a, 'TVF', i, 'Mode', 'mode', { dataType: 'String', kind: 'event', sim: 'enum_rare:NORMAL|CONGESTED', desc: `Mode ventilasi terowongan fan ${i}` });
        add('TVS', a, 'TVF', i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'major', sim: 'alarm', desc: `Tunnel ventilation fan ${i} fault` });
      }
    }

    // ---- Kondisi lingkungan stasiun ----
    add('ENV', 'PLT', 'ENV', null, 'PlatformTemp', 'platform_temp', { dataType: 'Double', unit: '°C', min: ug ? 25 : 28, max: ug ? 28 : 33, sim: 'analog_daily', desc: 'Suhu area peron' });
    add('ENV', 'PLT', 'ENV', null, 'PlatformHumidity', 'platform_humidity', { dataType: 'Double', unit: '%RH', min: 55, max: 75, sim: 'analog', desc: 'Kelembapan area peron' });
    add('ENV', 'CNC', 'ENV', null, 'ConcourseTemp', 'concourse_temp', { dataType: 'Double', unit: '°C', min: ug ? 24 : 27, max: ug ? 27 : 32, sim: 'analog_daily', desc: 'Suhu area concourse' });
    if (ug) {
      add('ENV', 'PLT', 'ENV', null, 'CO2', 'co2', { dataType: 'Double', unit: 'ppm', min: 500, max: 900, sim: 'analog_daily', desc: 'Kadar CO2 area peron' });
    }

    // ---- Pintu peron: PSD (bawah tanah, full height) / APG (layang, half height) ----
    const doorSys = ug ? 'PSD' : 'APG';
    const doorName = ug ? 'Platform screen door' : 'Automatic platform gate';
    for (let i = 1; i <= 2; i += 1) {
      const a = `${doorSys}${pad(i)}`;
      const side = i === 1 ? 'arah Bundaran HI' : 'arah Lebak Bulus';
      add(doorSys, a, doorSys, i, 'DoorStatus', 'door_status', { dataType: 'String', sim: `door:${i}`, desc: `${doorName} peron ${side}: OPEN/CLOSED` });
      add(doorSys, a, doorSys, i, 'ClosedLocked', 'closed_locked', { dataType: 'Boolean', sim: `door_locked:${i}`, desc: `${doorName} peron ${side}: semua pintu tertutup & terkunci` });
      add(doorSys, a, doorSys, i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'major', sim: 'alarm', desc: `${doorName} peron ${side} fault` });
    }

    // ---- Eskalator ----
    const escCount = ug ? 8 : 6;
    for (let i = 1; i <= escCount; i += 1) {
      const a = `ESC${pad(i)}`;
      add('VTS', a, 'ESC', i, 'Running', 'running', { dataType: 'Boolean', sim: 'run_ophours', desc: `Eskalator ${i} beroperasi` });
      add('VTS', a, 'ESC', i, 'Direction', 'direction', { dataType: 'String', sim: i % 2 ? 'fixed:UP' : 'fixed:DOWN', desc: `Arah eskalator ${i}` });
      add('VTS', a, 'ESC', i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'minor', sim: 'alarm', desc: `Eskalator ${i} berhenti karena fault` });
    }

    // ---- Lift ----
    for (let i = 1; i <= 2; i += 1) {
      const a = `ELV${pad(i)}`;
      add('VTS', a, 'ELV', i, 'Status', 'status', { dataType: 'String', sim: 'enum_cycle:IDLE|MOVING', desc: `Status lift ${i}` });
      add('VTS', a, 'ELV', i, 'Floor', 'floor', { dataType: 'Int32', min: ug ? -2 : 0, max: ug ? 0 : 2, sim: 'floor', desc: `Posisi lantai lift ${i}` });
      add('VTS', a, 'ELV', i, 'Fault', 'fault', { dataType: 'Boolean', kind: 'alarm', severity: 'minor', sim: 'alarm', desc: `Lift ${i} fault` });
    }

    // ---- Daya: Electric Room (tegangan rendah 400 V) ----
    add('PWR', 'ER01', 'ER', 1, 'EnergyImport', 'energy', { dataType: 'Double', unit: 'kWh', min: ug ? 350 : 180, max: ug ? 650 : 320, sim: 'counter', desc: 'Energi kumulatif panel LV (laju kW pada normal_min–max)' });
    add('PWR', 'ER01', 'ER', 1, 'ActivePower', 'active_power', { dataType: 'Double', unit: 'kW', min: ug ? 350 : 180, max: ug ? 650 : 320, sim: 'analog_daily', desc: 'Daya aktif panel LV' });
    add('PWR', 'ER01', 'ER', 1, 'VoltageLL', 'voltage_ll', { dataType: 'Double', unit: 'V', min: 395, max: 405, sim: 'analog', desc: 'Tegangan line-line panel LV' });
    add('PWR', 'ER01', 'ER', 1, 'PowerFactor', 'power_factor', { dataType: 'Double', min: 0.9, max: 0.98, sim: 'analog', desc: 'Faktor daya panel LV' });
    add('PWR', 'ER01', 'ER', 1, 'IncomerTrip', 'incomer_trip', { dataType: 'Boolean', kind: 'alarm', severity: 'critical', sim: 'alarm_rare', desc: 'Incomer breaker LV trip' });

    // ---- Drainase (stasiun bawah tanah) ----
    if (ug) {
      add('DRN', 'SMP01', 'SMP', 1, 'Level', 'level', { dataType: 'Double', unit: '%', min: 15, max: 75, sim: 'sump', desc: 'Level air sump pit' });
      add('DRN', 'SMP01', 'SMP', 1, 'PumpRunning', 'pump_running', { dataType: 'Boolean', sim: 'sump_pump', desc: 'Pompa drainase sump pit beroperasi' });
      add('DRN', 'SMP01', 'SMP', 1, 'HighLevel', 'high_level', { dataType: 'Boolean', kind: 'alarm', severity: 'major', sim: 'alarm_rare', desc: 'Level air sump pit tinggi' });
    }

    // ---- Tangki air bersih ----
    add('PLB', 'TNK01', 'TNK', 1, 'Level', 'level', { dataType: 'Double', unit: '%', min: 45, max: 95, sim: 'analog', desc: 'Level tangki air bersih' });

    // ---- Fire alarm ----
    add('FAS', 'FACP', 'FACP', null, 'FireAlarm', 'fire_alarm', { dataType: 'Boolean', kind: 'alarm', severity: 'critical', sim: 'alarm_rare', desc: 'Fire alarm aktif' });
    add('FAS', 'FACP', 'FACP', null, 'PanelFault', 'panel_fault', { dataType: 'Boolean', kind: 'alarm', severity: 'minor', sim: 'alarm', desc: 'Fire alarm control panel fault' });

    // ---- Penerangan ----
    add('LTG', 'PLT', 'LTG', null, 'PlatformLighting', 'platform_lighting', { dataType: 'Boolean', sim: 'run_ophours', desc: 'Penerangan peron menyala penuh' });
  }
  return rows;
}

if (require.main === module) {
  const rows = build();
  const out = path.resolve(__dirname, '..', 'data', 'scada-tags.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(COLUMNS, rows));
  const bySystem = rows.reduce((acc, r) => ({ ...acc, [r.system]: (acc[r.system] ?? 0) + 1 }), {});
  console.log(`wrote ${rows.length} tags for ${STATIONS.length} stations → ${path.relative(process.cwd(), out)}`);
  console.log(bySystem);
}

module.exports = { build, STATIONS, COLUMNS };

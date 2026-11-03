'use strict';

/**
 * Generator katalog PIDS / PIDC (DUMMY REALISTIS).
 *
 * Output: data/pids-stations.csv — urutan stasiun, waktu tempuh kumulatif dari Lebak Bulus, peron per arah, dwell.
 *
 * Dasar: 13 stasiun Fase 1 Lebak Bulus – Bundaran HI, waktu tempuh ujung ke ujung ±30 menit.
 * ASUMSI (ganti dengan data PIDC/timetable resmi): waktu tempuh antarstasiun, nomor peron per arah, dwell,
 * headway (5 menit jam sibuk, 10 menit di luar jam sibuk), format nomor perjalanan.
 *
 * Pemakaian: npm run pids:generate
 */

const fs = require('node:fs');
const path = require('node:path');
const { toCsv } = require('../src/core/csv');
const { STATIONS } = require('./generate-scada-tags');

/** Waktu tempuh kumulatif (menit) dari Lebak Bulus, urut sesuai STATIONS. */
const OFFSET_MIN = [0, 3, 5, 7, 9, 11, 13, 16, 18, 20, 23, 25, 28];

const COLUMNS = ['seq', 'station_code', 'station_name', 'station_type', 'offset_min', 'platform_nb', 'platform_sb', 'dwell_s'];

function buildStations() {
  return STATIONS.map(([code, name, type], i) => ({
    seq: i + 1,
    station_code: code,
    station_name: name,
    station_type: type,
    offset_min: OFFSET_MIN[i],
    platform_nb: '1', // arah Bundaran HI (northbound)
    platform_sb: '2', // arah Lebak Bulus (southbound)
    dwell_s: ['DKA', 'BLM', 'LBB', 'BHI'].includes(code) ? 45 : 30,
  }));
}

if (require.main === module) {
  const out = path.resolve(__dirname, '..', 'data', 'pids-stations.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rows = buildStations();
  fs.writeFileSync(out, toCsv(COLUMNS, rows));
  console.log(`wrote ${rows.length} stations → data/pids-stations.csv (LBB→BHI ${rows.at(-1).offset_min} menit)`);
}

module.exports = { buildStations };

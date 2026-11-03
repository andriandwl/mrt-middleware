'use strict';

const path = require('node:path');
const { pool } = require('../src/storage/pool');
const { readCsvFile } = require('../src/core/csv');

/**
 * Impor katalog tag (CSV) ke tabel tag_mappings.
 * Kolom yang dipakai: node_id (atau source_key), station_code, asset_id, metric, unit, (opsional) scale, active.
 *
 * Pemakaian:
 *   npm run mappings:import                          # default data/scada-tags.csv, source=scada
 *   npm run mappings:import -- data/nms-mappings.csv nms
 *   npm run mappings:import -- path/ke/tags-vendor.csv scada
 *
 * Aman dijalankan berulang (upsert per source + node_id). Baris yang tidak valid dilewati dan dilaporkan.
 */
async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'scada-tags.csv'));
  const source = process.argv[3] || 'scada';
  if (!['scada', 'nms', 'pids'].includes(source)) throw new Error(`source tidak valid: ${source}`);

  const rows = readCsvFile(file);
  const errors = [];
  const valid = [];
  rows.forEach((raw, i) => {
    const line = i + 2;
    // Kolom kunci boleh bernama node_id (SCADA) atau source_key (NMS/PIDS)
    const r = { ...raw, node_id: raw.node_id || raw.source_key };
    const missing = ['node_id', 'station_code', 'asset_id', 'metric'].filter((k) => !r[k]);
    if (missing.length) return errors.push(`baris ${line}: kolom kosong ${missing.join(', ')}`);
    const scale = r.scale === undefined || r.scale === '' ? 1 : Number(r.scale);
    if (!Number.isFinite(scale)) return errors.push(`baris ${line}: scale bukan angka`);
    return valid.push({
      sourceKey: r.node_id,
      assetId: r.asset_id,
      station: r.station_code.toUpperCase(),
      metric: r.metric,
      unit: r.unit || null,
      scale,
      active: r.active ? !['false', '0', 'no', 'tidak'].includes(r.active.toLowerCase()) : true,
    });
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of valid) {
      await client.query(
        `INSERT INTO tag_mappings (source, source_key, asset_id, station, metric, unit, scale, active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (source, source_key) DO UPDATE SET
           asset_id = EXCLUDED.asset_id, station = EXCLUDED.station, metric = EXCLUDED.metric,
           unit = EXCLUDED.unit, scale = EXCLUDED.scale, active = EXCLUDED.active, updated_at = now()`,
        [source, m.sourceKey, m.assetId, m.station, m.metric, m.unit, m.scale, m.active],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`${valid.length} mapping diimpor ke source=${source} dari ${path.basename(file)}`);
  if (errors.length) {
    console.log(`${errors.length} baris dilewati:`);
    errors.slice(0, 20).forEach((e) => console.log(`  - ${e}`));
  }
  console.log('Middleware yang sedang berjalan memuat ulang mapping dalam ±60 detik.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

"use strict";

const { pool } = require("../src/storage/pool");
const { runMaintenance, tables } = require("../src/maintenance/maintenance");

/**
 * Jalankan maintenance database sekali: buat partisi, hitung agregat per jam, terapkan retensi.
 * Server juga menjalankannya otomatis tiap MAINTENANCE_INTERVAL_MIN menit.
 *
 *   npm run db:maintain                  # agregasi 3 jam terakhir
 *   npm run db:maintain -- --hours 168   # hitung ulang agregat 7 hari terakhir (mis. setelah impor data lama)
 */
async function main() {
  const i = process.argv.indexOf("--hours");
  const hours = i > -1 ? Number(process.argv[i + 1]) : 3;
  console.log(
    "Retensi (hari, 0 = simpan):",
    Object.fromEntries(tables().map((t) => [t.name, t.keepDays])),
  );
  const s = await runMaintenance(pool, { aggregateHours: hours });
  if (s.skipped)
    console.log("Maintenance sedang berjalan di instance lain, dilewati.");
  else {
    console.log(`Partisi baru: ${s.createdPartitions}`);
    console.log(
      `Partisi dihapus (retensi): ${s.droppedPartitions.length ? s.droppedPartitions.join(", ") : "-"}`,
    );
    console.log(`Baris agregat per jam ditulis: ${s.aggregatedRows}`);
    console.log("Baris di partisi default (seharusnya 0):", s.defaultRows);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

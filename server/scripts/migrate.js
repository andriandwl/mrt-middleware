'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/storage/pool');

/** Jalankan file migrations/*.sql yang belum pernah dijalankan, berurutan. */
async function main() {
  const dir = path.resolve(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  console.log('migrations up to date');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

'use strict';

const { randomBytes } = require('node:crypto');
const { pool } = require('../src/storage/pool');
const { Repository } = require('../src/storage/repository');
const { hashApiKey } = require('../src/api/auth');

/**
 * Buat klien API baru dan tampilkan API key SEKALI.
 * Pemakaian:
 *   npm run client:create -- <nama> <viewer|operator|admin> <scope,scope,...>
 * Contoh:
 *   npm run client:create -- dashboard-occ operator "scada:*,nms:*,pids:*"
 *   npm run client:create -- pids-lebak-bulus viewer "pids:LBB"
 */
async function main() {
  const [name, role, scopesArg] = process.argv.slice(2);
  if (!name || !['viewer', 'operator', 'admin'].includes(role ?? '') || !scopesArg) {
    console.error('Usage: npm run client:create -- <name> <viewer|operator|admin> <scope,scope,...>');
    process.exit(1);
  }
  const scopes = scopesArg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const apiKey = `mrtmw_${randomBytes(32).toString('base64url')}`;
  const repo = new Repository(pool);
  const client = await repo.createClient(name, hashApiKey(apiKey), role, scopes);
  console.log('Client created:', client);
  console.log('\nAPI KEY (simpan sekarang, tidak akan ditampilkan lagi):\n');
  console.log(apiKey);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});

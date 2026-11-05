import { Pool } from 'pg';
import { env } from '../config.js';
import { logger } from '../logger.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'mrt-middleware',
});

pool.on('error', (err) => logger.error({ err: err.message }, 'postgres pool error'));

export { pool };

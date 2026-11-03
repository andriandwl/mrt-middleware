'use strict';

const { z } = require('zod');
const { BaseConnector, getPath, toDate } = require('./base.connector');
const { secretFromEnv } = require('../config');

const optionsSchema = z.object({
  url: z.string().url(),
  intervalMs: z.number().int().min(1000).default(10_000),
  timeoutMs: z.number().int().positive().default(8_000),
  tokenEnv: z.string().optional(),
  headers: z.record(z.string()).default({}),
  /** Path ke array item di response, mis. "data.items". Kosong = response itu sendiri. */
  itemsPath: z.string().optional(),
  idField: z.string().default('id'),
  timestampField: z.string().default('timestamp'),
  /** Berapa kali gagal berturut-turut sebelum dianggap koneksi putus */
  failThreshold: z.number().int().positive().default(3),
});

/**
 * Adapter generik polling HTTP (GET saja). Cocok untuk NMS/PIDS yang menyediakan REST API.
 * Hanya method GET yang dipakai — tidak ada request yang mengubah state sumber.
 */
class HttpPollConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    this.timer = null;
    this.failures = 0;
  }

  async connectOnce() {
    this.failures = 0;
    await this.pollOnce(); // gagal di sini → BaseConnector melakukan retry
    this.timer = setInterval(() => {
      this.pollOnce()
        .then(() => {
          this.failures = 0;
        })
        .catch((err) => {
          this.failures += 1;
          this.log.warn({ err: String(err), failures: this.failures }, 'poll failed');
          if (this.failures >= this.opts.failThreshold) this.fail(err);
        });
    }, this.opts.intervalMs);
  }

  async pollOnce() {
    const token = secretFromEnv(this.opts.tokenEnv);
    const res = await fetch(this.opts.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...this.opts.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.opts.url}`);
    const body = await res.json();
    const items = getPath(body, this.opts.itemsPath);
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const id = getPath(item, this.opts.idField);
      const ts = toDate(getPath(item, this.opts.timestampField));
      this.emitRecord(String(id ?? JSON.stringify(item).slice(0, 200)), ts, item);
    }
  }

  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { HttpPollConnector };

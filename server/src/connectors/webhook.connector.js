'use strict';

const { timingSafeEqual } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { BaseConnector, getPath, toDate } = require('./base.connector');
const { secretFromEnv } = require('../config');

const optionsSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive(),
  path: z.string().startsWith('/').default('/ingest'),
  secretEnv: z.string(),
  itemsPath: z.string().optional(),
  idField: z.string().default('id'),
  timestampField: z.string().default('timestamp'),
  maxBody: z.string().default('1mb'),
});

/**
 * Adapter generik push (webhook). Sumber (NMS/PIDS) mengirim POST JSON ke middleware.
 * Listener berjalan di port terpisah (sisi jaringan OT), terpisah dari API konsumen.
 * Autentikasi: header `X-Webhook-Secret` dibandingkan constant-time.
 */
class WebhookConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    /** @type {import('node:http').Server | null} */
    this.server = null;
  }

  async connectOnce() {
    const secret = secretFromEnv(this.opts.secretEnv);
    if (!secret) throw new Error(`Webhook secret env ${this.opts.secretEnv} is empty`);
    const expected = Buffer.from(secret);

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: this.opts.maxBody }));
    app.post(this.opts.path, (req, res) => {
      const given = Buffer.from(String(req.header('x-webhook-secret') ?? ''));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        this.log.warn({ ip: req.ip }, 'webhook rejected: bad secret');
        return res.status(401).json({ error: 'unauthorized' });
      }
      const items = getPath(req.body, this.opts.itemsPath);
      const list = Array.isArray(items) ? items : [items];
      let accepted = 0;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = getPath(item, this.opts.idField);
        const ts = toDate(getPath(item, this.opts.timestampField));
        this.emitRecord(String(id ?? JSON.stringify(item).slice(0, 200)), ts, item);
        accepted += 1;
      }
      return res.status(202).json({ accepted });
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(this.opts.port, this.opts.host, () => resolve());
      server.once('error', reject);
      server.on('close', () => this.fail(new Error('webhook server closed')));
      this.server = server;
    });
  }

  async disconnect() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.removeAllListeners('close');
    await new Promise((resolve) => s.close(() => resolve()));
  }
}

module.exports = { WebhookConnector };

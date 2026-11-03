'use strict';

const WebSocket = require('ws');
const { z } = require('zod');
const { BaseConnector, getPath, toDate } = require('./base.connector');
const { secretFromEnv } = require('../config');

const optionsSchema = z.object({
  url: z.string().regex(/^wss?:\/\//, 'url harus ws:// atau wss://'),
  tokenEnv: z.string().optional(),
  headers: z.record(z.string()).default({}),
  /** Pesan langganan yang dikirim setelah tersambung (opsional). Hanya untuk memilih data, bukan perintah ke sumber. */
  subscribe: z.unknown().optional(),
  typeField: z.string().default('type'),
  /** Tipe pesan yang tidak diteruskan ke pipeline (tetap menyegarkan watchdog). */
  ignoreTypes: z.array(z.string()).default(['heartbeat']),
  /** Bila pesan berisi array (mis. snapshot), path ke array tersebut. */
  itemsPath: z.string().default('items'),
  idField: z.string().default('messageId'),
  timestampField: z.string().default('generatedAt'),
  /** Feed dianggap mati bila tidak ada pesan sama sekali selama ini. */
  idleTimeoutMs: z.number().int().positive().default(60_000),
});

/**
 * Klien WebSocket generik untuk feed push (mis. PIDC). Read-only: hanya menerima pesan;
 * satu-satunya pesan keluar adalah `subscribe` opsional dari config.
 */
class WebSocketClientConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    this.ws = null;
    this.watchdog = null;
  }

  async connectOnce() {
    const token = secretFromEnv(this.opts.tokenEnv);
    const ws = new WebSocket(this.opts.url, {
      headers: { ...this.opts.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      handshakeTimeout: 10_000,
      maxPayload: 8 * 1024 * 1024,
    });
    this.ws = ws;

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode} saat handshake`)));
    });

    ws.on('error', (err) => this.fail(err));
    ws.on('close', (code, reason) => this.fail(new Error(`WebSocket closed ${code} ${reason}`)));
    ws.on('message', (buf) => this.onMessage(buf));
    if (this.opts.subscribe !== undefined) ws.send(JSON.stringify(this.opts.subscribe));
    this.armWatchdog();
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.log.warn({ idleMs: this.opts.idleTimeoutMs }, 'feed idle, reconnecting');
      this.ws?.terminate();
      this.fail(new Error('feed idle'));
    }, this.opts.idleTimeoutMs);
  }

  onMessage(buf) {
    this.armWatchdog();
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      this.log.warn('non-JSON message ignored');
      return;
    }
    if (this.opts.ignoreTypes.includes(String(getPath(msg, this.opts.typeField)))) return;

    const items = getPath(msg, this.opts.itemsPath);
    const list = Array.isArray(items) ? items : [msg];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (this.opts.ignoreTypes.includes(String(getPath(item, this.opts.typeField)))) continue;
      const id = getPath(item, this.opts.idField);
      const ts = toDate(getPath(item, this.opts.timestampField));
      this.emitRecord(String(id ?? JSON.stringify(item).slice(0, 200)), ts, item);
    }
  }

  async disconnect() {
    clearTimeout(this.watchdog);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners('close');
    ws.removeAllListeners('error');
    ws.on('error', () => undefined);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
}

module.exports = { WebSocketClientConnector };

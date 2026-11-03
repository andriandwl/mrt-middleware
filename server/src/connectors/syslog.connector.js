'use strict';

const dgram = require('node:dgram');
const { z } = require('zod');
const { BaseConnector } = require('./base.connector');

const optionsSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(5514),
  /** Hanya terima dari IP ini (kosong = semua). Disarankan diisi IP perangkat/NMS. */
  allowFrom: z.array(z.string()).default([]),
});

/**
 * Listener Syslog UDP (RFC 3164 / RFC 5424). Pasif — hanya menerima log dari NMS/perangkat.
 * Parsing isi pesan dilakukan oleh parser (nms-syslog).
 */
class SyslogConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    /** @type {dgram.Socket | null} */
    this.socket = null;
    this.seq = 0;
  }

  async connectOnce() {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (msg, rinfo) => {
      if (this.opts.allowFrom.length && !this.opts.allowFrom.includes(rinfo.address)) return;
      this.seq += 1;
      this.emitRecord(`${rinfo.address}:${Date.now()}:${this.seq}`, null, {
        message: msg.toString('utf8'),
        fromAddress: rinfo.address,
      });
    });
    socket.on('error', (err) => this.fail(err));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.opts.port, this.opts.host, () => {
        socket.off('error', reject);
        resolve();
      });
    });
  }

  async disconnect() {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.removeAllListeners('error');
    await new Promise((resolve) => s.close(() => resolve()));
  }
}

module.exports = { SyslogConnector };

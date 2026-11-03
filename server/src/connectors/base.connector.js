'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { backoffDelay, sleep } = require('../core/backoff');
const { logger: rootLogger } = require('../logger');

/**
 * Basis konektor dengan loop reconnect otomatis (exponential backoff + jitter, tanpa batas percobaan).
 * Subclass wajib mengimplementasikan:
 *  - async connectOnce(): buka koneksi; resolve saat tersambung, lalu panggil this.fail(err) bila koneksi putus.
 *  - async disconnect(): tutup koneksi dengan bersih.
 */
class BaseConnector extends EventEmitter {
  /** @param {import('../config').ConnectorConfig} config */
  constructor(config) {
    super();
    this.config = config;
    this.id = config.id;
    this.source = config.source;
    this.options = config.options;
    this.log = rootLogger.child({ connector: config.id, source: config.source });

    /** @type {import('../core/types').ConnectorState} */
    this._state = 'idle';
    this._lastError = null;
    this._lastRecordTs = null;
    this._attempts = 0;
    this._abort = new AbortController();
    /** @type {null | (() => void)} */
    this._lost = null;
  }

  /* eslint-disable class-methods-use-this */
  async connectOnce() {
    throw new Error('connectOnce() not implemented');
  }

  async disconnect() {
    throw new Error('disconnect() not implemented');
  }
  /* eslint-enable class-methods-use-this */

  async start() {
    this._abort = new AbortController();
    void this._loop();
  }

  async stop() {
    this._abort.abort();
    if (this._lost) this._lost();
    await this.disconnect().catch((err) => this.log.warn({ err: String(err) }, 'disconnect error'));
    this._setState('stopped');
  }

  /** @returns {import('../core/types').ConnectorStatus} */
  status() {
    return {
      id: this.id,
      source: this.source,
      type: this.config.type,
      state: this._state,
      lastError: this._lastError,
      lastRecordTs: this._lastRecordTs,
      reconnectAttempts: this._attempts,
    };
  }

  /**
   * Dipanggil subclass setiap ada data baru dari sumber.
   * @param {string} sourceId
   * @param {Date|null|undefined} sourceTs
   * @param {unknown} payload
   */
  emitRecord(sourceId, sourceTs, payload) {
    const now = new Date();
    const ts = sourceTs instanceof Date && !Number.isNaN(sourceTs.getTime()) ? sourceTs : now;
    /** @type {import('../core/types').RawRecord} */
    const record = {
      source: this.source,
      connectorId: this.id,
      sourceId,
      sourceTs: ts,
      receivedTs: now,
      payload,
      correlationId: randomUUID(),
    };
    this._lastRecordTs = now;
    this.emit('record', record);
  }

  /** Dipanggil subclass ketika koneksi putus / error fatal → memicu reconnect. */
  fail(err) {
    this._lastError = err instanceof Error ? err.message : String(err);
    this.log.warn({ err: this._lastError }, 'connection lost');
    if (this._lost) this._lost();
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('status', this.status());
  }

  async _loop() {
    const { signal } = this._abort;
    while (!signal.aborted) {
      try {
        this._setState('connecting');
        await this.connectOnce();
        this._attempts = 0;
        this._lastError = null;
        this._setState('connected');
        this.log.info('connected');
        // Tunggu sampai koneksi dilaporkan putus atau konektor dihentikan
        await new Promise((resolve) => {
          this._lost = resolve;
        });
        this._lost = null;
        if (signal.aborted) break;
        this._setState('disconnected');
        await this.disconnect().catch(() => undefined);
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
        this._setState('error');
        this.log.error({ err: this._lastError }, 'connect failed');
        await this.disconnect().catch(() => undefined);
      }
      if (signal.aborted) break;
      const delay = backoffDelay(this._attempts++);
      this.log.info({ delayMs: delay, attempt: this._attempts }, 'reconnecting');
      await sleep(delay, signal);
    }
  }
}

/** Ambil nilai bertingkat dari objek, mis. getPath(obj, 'data.items'). */
function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

/** @returns {Date|null} */
function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

module.exports = { BaseConnector, getPath, toDate };

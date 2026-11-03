'use strict';

const snmp = require('net-snmp');
const { z } = require('zod');
const { BaseConnector } = require('./base.connector');
const { secretFromEnv } = require('../config');
const { VARBINDS } = require('../parsers/snmp-oids');

const optionsSchema = z.object({
  host: z.string().default('0.0.0.0'),
  /** Port standar trap 162 butuh hak root; default 1162 lalu forward di firewall bila perlu. */
  port: z.number().int().positive().default(1162),
  /** Nama env yang berisi community string (bisa beberapa, dipisah koma). */
  communityEnv: z.string(),
  /** Hanya terima dari IP ini (kosong = semua). Isi dengan IP NMS / perangkat. */
  allowFrom: z.array(z.string()).default([]),
});

function toPlain(value) {
  if (Buffer.isBuffer(value)) {
    const s = value.toString('utf8');
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7E -￿]*$/.test(s) ? s : value.toString('hex');
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * Penerima SNMP trap/inform (v1, v2c). PASIF: hanya mendengarkan di UDP, tidak pernah mengirim
 * GET/SET ke perangkat. Inform dibalas ACK sesuai protokol oleh library (bukan perintah ke perangkat).
 *
 * Payload ke parser: { trapOid, agentAddress, sysName, sourceAddress, requestId, varbinds: {oid: value} }
 * agentAddress diambil dari varbind snmpTrapAddress.0 (trap yang diteruskan NMS) atau alamat pengirim.
 */
class SnmpTrapConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    this.receiver = null;
  }

  async connectOnce() {
    const communities = (secretFromEnv(this.opts.communityEnv) ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!communities.length) throw new Error(`Community env ${this.opts.communityEnv} is empty`);

    await new Promise((resolve, reject) => {
      let started = false;
      const receiver = snmp.createReceiver(
        { port: this.opts.port, address: this.opts.host, transport: 'udp4', disableAuthorization: false },
        (err, notification) => {
          if (err) {
            // Error socket (mis. EADDRINUSE) → gagal/reconnect; error paket (community salah, rusak) → catat saja
            if (err.code && err.syscall) {
              if (started) this.fail(err);
              else reject(err);
              return;
            }
            this.log.warn({ err: err.message }, 'trap rejected');
            return;
          }
          this.handle(notification);
        },
      );
      communities.forEach((c) => receiver.getAuthorizer().addCommunity(c));
      this.receiver = receiver;

      const socket = Object.values(receiver.listener?.sockets ?? {})[0];
      if (socket && typeof socket.once === 'function') {
        socket.once('listening', () => {
          started = true;
          resolve();
        });
      } else {
        // fallback bila struktur internal library berubah
        started = true;
        setTimeout(resolve, 200);
      }
    });
  }

  handle(notification) {
    const { pdu, rinfo } = notification;
    if (this.opts.allowFrom.length && !this.opts.allowFrom.includes(rinfo.address)) return;
    const varbinds = {};
    for (const vb of pdu.varbinds ?? []) varbinds[vb.oid] = toPlain(vb.value);

    // SNMPv1 trap membawa enterprise + specific/generic trap; v2c membawa snmpTrapOID.0
    let trapOid = varbinds[VARBINDS.snmpTrapOID];
    if (!trapOid && pdu.enterprise) {
      trapOid = pdu.generic === 6 ? `${pdu.enterprise}.0.${pdu.specific}` : `1.3.6.1.6.3.1.1.5.${(pdu.generic ?? 0) + 1}`;
    }
    const agentAddress = String(varbinds[VARBINDS.snmpTrapAddress] ?? pdu.agentAddr ?? rinfo.address);

    this.emitRecord(`${agentAddress}|${trapOid}|${pdu.id}`, null, {
      trapOid: String(trapOid ?? 'unknown'),
      agentAddress,
      sysName: varbinds[VARBINDS.sysName] ?? null,
      sourceAddress: rinfo.address,
      requestId: pdu.id,
      varbinds,
    });
  }

  async disconnect() {
    const r = this.receiver;
    this.receiver = null;
    if (r) await new Promise((resolve) => r.close(() => resolve())).catch(() => undefined);
  }
}

module.exports = { SnmpTrapConnector };

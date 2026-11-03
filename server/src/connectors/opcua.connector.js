'use strict';

const path = require('node:path');
const {
  AttributeIds,
  ClientMonitoredItemGroup,
  ClientSubscription,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
  UserTokenType,
} = require('node-opcua');
const { z } = require('zod');
const { BaseConnector } = require('./base.connector');
const { secretFromEnv } = require('../config');
const { readCsvFile } = require('../core/csv');

const nodeSchema = z.object({
  nodeId: z.string().min(1),
  /** telemetry = nilai; event = perubahan status; alarm = boolean aktif/normal */
  kind: z.enum(['telemetry', 'event', 'alarm']).default('telemetry'),
  severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
  description: z.string().optional(),
});

const optionsSchema = z
  .object({
    endpointUrl: z.string().startsWith('opc.tcp://'),
    securityMode: z.enum(['None', 'Sign', 'SignAndEncrypt']).default('SignAndEncrypt'),
    securityPolicy: z.string().default('Basic256Sha256'),
    userEnv: z.string().optional(),
    passwordEnv: z.string().optional(),
    publishingIntervalMs: z.number().int().positive().default(1000),
    samplingIntervalMs: z.number().int().positive().default(1000),
    /** Batas node per request Read (sesuaikan dengan MaxNodesPerRead server). */
    readChunkSize: z.number().int().positive().default(200),
    /** Daftar node langsung di config ... */
    nodes: z.array(nodeSchema).optional(),
    /** ... atau dari katalog CSV (kolom node_id, kind, severity, description). Path relatif ke folder server. */
    nodesCsv: z.string().optional(),
  })
  .refine((o) => (o.nodes?.length ?? 0) > 0 || Boolean(o.nodesCsv), { message: 'isi `nodes` atau `nodesCsv`' });

function loadNodes(opts) {
  const list = [...(opts.nodes ?? [])];
  if (opts.nodesCsv) {
    const file = path.resolve(opts.nodesCsv);
    for (const r of readCsvFile(file)) {
      if (!r.node_id) continue;
      list.push(
        nodeSchema.parse({
          nodeId: r.node_id,
          kind: r.kind || 'telemetry',
          severity: r.severity || undefined,
          description: r.description || undefined,
        }),
      );
    }
  }
  const seen = new Set();
  return list.filter((n) => (seen.has(n.nodeId) ? false : seen.add(n.nodeId)));
}

/**
 * OPC UA Client READ-ONLY.
 * Hanya memakai: createSession, read, createSubscription, createMonitoredItems.
 * TIDAK memakai: write, call (method), addNodes, deleteNodes, atau service lain yang mengubah server.
 * Lapisan kedua: gunakan user OPC UA dengan role read-only di sisi server SCADA.
 */
class OpcUaConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.opts = optionsSchema.parse(config.options);
    this.nodes = loadNodes(this.opts);
    this.client = null;
    this.session = null;
    this.subscription = null;
    this.log.info({ nodes: this.nodes.length }, 'opc ua nodes loaded');
  }

  async connectOnce() {
    const o = this.opts;
    const client = OPCUAClient.create({
      applicationName: 'MRT-Middleware',
      endpointMustExist: false,
      securityMode: MessageSecurityMode[o.securityMode],
      securityPolicy: SecurityPolicy[o.securityPolicy] ?? SecurityPolicy.None,
      // Reconnect dikelola BaseConnector, bukan oleh node-opcua
      connectionStrategy: { maxRetry: 0, initialDelay: 1000, maxDelay: 1000 },
      keepSessionAlive: true,
    });
    this.client = client;
    client.on('connection_lost', () => this.fail(new Error('OPC UA connection lost')));

    await client.connect(o.endpointUrl);

    const user = secretFromEnv(o.userEnv);
    const identity = user
      ? { type: UserTokenType.UserName, userName: user, password: secretFromEnv(o.passwordEnv) ?? '' }
      : { type: UserTokenType.Anonymous };
    this.session = await client.createSession(identity);
    this.session.on('session_closed', () => this.fail(new Error('OPC UA session closed')));

    // Initial read (dipecah per chunk) agar dashboard langsung punya nilai awal.
    // Timestamp sumbernya disimpan: notifikasi pertama subscription biasanya mengulang nilai yang sama.
    const initialTs = new Map();
    for (let i = 0; i < this.nodes.length; i += o.readChunkSize) {
      const chunk = this.nodes.slice(i, i + o.readChunkSize);
      const values = await this.session.read(chunk.map((n) => ({ nodeId: n.nodeId, attributeId: AttributeIds.Value })));
      values.forEach((dv, j) => {
        initialTs.set(chunk[j].nodeId, dv.sourceTimestamp?.getTime() ?? null);
        this.handleValue(chunk[j], dv, true);
      });
    }

    this.subscription = ClientSubscription.create(this.session, {
      requestedPublishingInterval: o.publishingIntervalMs,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 2000,
      publishingEnabled: true,
      priority: 10,
    });
    this.subscription.on('terminated', () => this.fail(new Error('OPC UA subscription terminated')));

    const group = ClientMonitoredItemGroup.create(
      this.subscription,
      this.nodes.map((n) => ({ nodeId: n.nodeId, attributeId: AttributeIds.Value })),
      { samplingInterval: o.samplingIntervalMs, discardOldest: true, queueSize: 10 },
      TimestampsToReturn.Both,
    );
    const notified = new Set();
    group.on('changed', (_item, dv, index) => {
      const node = this.nodes[index];
      if (!node) return;
      if (!notified.has(index)) {
        notified.add(index);
        // Notifikasi pertama = nilai saat subscribe. Lewati bila sama dengan hasil initial read,
        // dan tandai sebagai `initial` bila tidak, supaya alarm yang normal tidak tercatat "cleared".
        const ts = dv.sourceTimestamp?.getTime() ?? null;
        if (ts !== null && ts === initialTs.get(node.nodeId)) return;
        this.handleValue(node, dv, true);
        return;
      }
      this.handleValue(node, dv, false);
    });
    group.on('err', (msg) => this.log.warn({ msg }, 'monitored item group error'));
  }

  handleValue(node, dv, initial) {
    const value = dv.value?.value;
    this.emitRecord(node.nodeId, dv.sourceTimestamp ?? dv.serverTimestamp ?? null, {
      nodeId: node.nodeId,
      kind: node.kind,
      severity: node.severity ?? null,
      description: node.description ?? null,
      initial,
      value: typeof value === 'bigint' ? Number(value) : value,
      dataType: dv.value?.dataType,
      statusCode: dv.statusCode?.name,
      statusGood: dv.statusCode?.isGood() ?? false,
      sourceTimestamp: dv.sourceTimestamp?.toISOString() ?? null,
      serverTimestamp: dv.serverTimestamp?.toISOString() ?? null,
    });
  }

  async disconnect() {
    const { subscription, session, client } = this;
    this.subscription = null;
    this.session = null;
    this.client = null;
    await subscription?.terminate().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await client?.disconnect().catch(() => undefined);
  }
}

module.exports = { OpcUaConnector };

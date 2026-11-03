'use strict';

/**
 * Parser mengubah payload mentah per sumber menjadi DraftRecord[].
 * Daftarkan parser baru di `parsers` di bawah, lalu rujuk namanya di config/sources.json.
 *
 * @typedef {import('../core/types').Parser} Parser
 * @typedef {import('../core/types').Severity} Severity
 */

const path = require('node:path');
const { readCsvFile } = require('../core/csv');
const { VARBINDS } = require('./snmp-oids');

const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));
const pick = (o, ...keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};
const asObj = (v) => (v && typeof v === 'object' ? v : {});
const date = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
/** Kode stasiun dari prefix hostname "LBB-CSW01" → "LBB". */
const stationFromHost = (host) => {
  const m = /^([A-Z]{3})-/.exec(String(host ?? ''));
  return m ? m[1] : undefined;
};

/** @returns {Severity} */
function normalizeSeverity(v) {
  const s = String(v ?? '').toLowerCase();
  if (['critical', 'crit', 'emergency', 'emerg', 'alert', 'fatal', '1'].includes(s)) return 'critical';
  if (['major', 'error', 'err', 'high', '2'].includes(s)) return 'major';
  if (['minor', 'warning', 'warn', 'medium', '3'].includes(s)) return 'minor';
  return 'info';
}

/**
 * Infer station/asset/metric dari nodeId berpola "STATION.SYSTEM.ASSET.METRIC"
 * (mis. ns=2;s=LBB.ECS.AHU01.SupplyTemp). tag_mappings selalu menang bila tersedia.
 */
function inferFromNodeId(nodeId) {
  const id = nodeId.includes(';s=') ? nodeId.split(';s=')[1] : nodeId;
  const parts = id.split('.');
  if (parts.length >= 3) {
    return {
      station: parts[0],
      assetId: parts.slice(0, -1).join('.'),
      metric: parts[parts.length - 1],
    };
  }
  return {};
}

// =====================================================================
// SCADA (OPC UA)
// =====================================================================
/** @type {Parser} */
const scadaOpcua = (raw) => {
  const p = asObj(raw.payload);
  const nodeId = String(p.nodeId ?? raw.sourceId);
  const inferred = inferFromNodeId(nodeId);
  let quality = 'bad';
  if (p.statusGood) quality = 'good';
  else if (String(p.statusCode ?? '').startsWith('Uncertain')) quality = 'uncertain';

  // Alarm boolean: true = aktif, false = normal kembali. alarmKey = nodeId (pasangan raise/clear).
  if (p.kind === 'alarm') {
    const active = p.value === true || p.value === 1 || ['true', 'alarm', 'active', 'on'].includes(String(p.value).toLowerCase());
    // Saat initial read, alarm yang normal tidak perlu dicatat sebagai event "cleared"
    if (p.initial && !active) return [];
    const label = str(p.description) ?? `${inferred.assetId ?? nodeId} ${inferred.metric ?? ''}`.trim();
    return [
      {
        kind: 'event',
        sourceKey: nodeId,
        ...inferred,
        category: 'alarm',
        severity: active ? (p.severity ?? 'minor') : 'info',
        code: inferred.metric ?? null,
        message: active ? label : `${label} — normal kembali`,
        state: active ? 'active' : 'cleared',
        alarmKey: nodeId,
        rawValue: p.value,
      },
    ];
  }

  if (p.kind === 'event') {
    if (p.initial) return []; // status awal bukan perubahan status
    return [
      {
        kind: 'event',
        sourceKey: nodeId,
        ...inferred,
        category: 'status_change',
        severity: 'info',
        code: str(p.value) ?? null,
        message: `${str(p.description) ?? inferred.metric ?? nodeId}: ${String(p.value)}`,
        state: 'info',
        rawValue: p.value,
      },
    ];
  }
  return [{ kind: 'telemetry', sourceKey: nodeId, ...inferred, quality, rawValue: p.value }];
};

// =====================================================================
// NMS: SNMP trap (berbasis katalog data/nms-traps.csv)
// =====================================================================
let trapCatalog = null;
/** Katalog trap dimuat sekali. Path bisa diganti lewat env NMS_TRAPS_CSV. */
function loadTrapCatalog() {
  if (trapCatalog) return trapCatalog;
  const file = path.resolve(process.env.NMS_TRAPS_CSV || 'data/nms-traps.csv');
  const rows = readCsvFile(file);
  const byId = Object.fromEntries(rows.map((r) => [r.trap_id, r]));
  trapCatalog = { byOid: Object.fromEntries(rows.map((r) => [r.trap_oid, r])), byId };
  return trapCatalog;
}

/** Ambil nilai varbind berdasarkan OID dasar (cocok juga untuk OID ber-index, mis. ifDescr.12). */
function vb(varbinds, baseOid) {
  if (varbinds[baseOid] !== undefined) return varbinds[baseOid];
  const k = Object.keys(varbinds).find((o) => o.startsWith(`${baseOid}.`));
  return k ? varbinds[k] : undefined;
}

/** @type {Parser} */
const nmsSnmpTrap = (raw) => {
  const p = asObj(raw.payload);
  const v = asObj(p.varbinds);
  const host = str(p.sysName) ?? str(p.agentAddress) ?? 'unknown';
  const entry = loadTrapCatalog().byOid[p.trapOid];
  const fields = {
    ifIndex: vb(v, VARBINDS.ifIndex),
    ifDescr: vb(v, VARBINDS.ifDescr),
    value: vb(v, VARBINDS.value),
    threshold: vb(v, VARBINDS.threshold),
    component: vb(v, VARBINDS.component),
    peer: vb(v, VARBINDS.peer),
  };
  const base = {
    kind: 'event',
    sourceKey: String(p.agentAddress),
    assetId: host,
    station: stationFromHost(host),
  };

  if (!entry) {
    return [{ ...base, category: 'device_event', severity: 'info', code: String(p.trapOid), message: `Trap tidak dikenal ${p.trapOid} dari ${host}`, state: 'info' }];
  }

  const message = entry.message.replace(/\{(\w+)\}/g, (_m, k) => (fields[k] !== undefined ? String(fields[k]) : `?${k}`));
  const raiseId = entry.clears || entry.trap_id;
  const keyPart = entry.key_varbind ? fields[entry.key_varbind] ?? '' : '';
  return [
    {
      ...base,
      category: entry.category === 'alarm' ? 'alarm' : 'device_event',
      severity: entry.state === 'cleared' ? 'info' : normalizeSeverity(entry.severity),
      code: entry.name,
      message,
      state: entry.state,
      alarmKey: entry.state === 'info' ? null : `${p.agentAddress}|${raiseId}|${keyPart}`,
    },
  ];
};

// =====================================================================
// NMS: JSON generik (northbound REST / webhook)
// =====================================================================
/** @type {Parser} */
const nmsGenericJson = (raw) => {
  const p = asObj(raw.payload);
  const device = str(pick(p, 'deviceId', 'device_id', 'device', 'hostname', 'host', 'ne')) ?? 'unknown-device';
  const station = str(pick(p, 'station', 'site', 'location'));

  // Status/health berbentuk nilai → telemetry
  const metric = str(pick(p, 'metric', 'kpi', 'counter'));
  if (metric && pick(p, 'value') !== undefined) {
    return [
      {
        kind: 'telemetry',
        sourceKey: `${device}:${metric}`,
        assetId: device,
        station,
        metric,
        unit: str(p.unit) ?? null,
        quality: 'good',
        rawValue: p.value,
      },
    ];
  }

  const rawState = String(pick(p, 'state', 'status', 'alarmState') ?? '').toLowerCase();
  const state = ['cleared', 'clear', 'resolved', 'closed'].includes(rawState) ? 'cleared' : 'active';
  const type = String(pick(p, 'type', 'category', 'eventType') ?? 'alarm').toLowerCase();
  let category = 'device_event';
  if (type.includes('log')) category = 'log';
  else if (type.includes('alarm')) category = 'alarm';
  const alarmId = str(pick(p, 'alarmId', 'alarm_id', 'id'));
  return [
    {
      kind: 'event',
      sourceKey: device,
      assetId: device,
      station,
      category,
      severity: state === 'cleared' ? 'info' : normalizeSeverity(pick(p, 'severity', 'level', 'priority')),
      code: str(pick(p, 'code', 'alarmCode')) ?? alarmId ?? null,
      message: str(pick(p, 'message', 'description', 'text', 'summary')) ?? `${type} on ${device}`,
      state,
      alarmKey: category === 'alarm' && alarmId ? `${device}|${alarmId}` : null,
    },
  ];
};

// =====================================================================
// NMS: Syslog (RFC 5424 & RFC 3164)
// =====================================================================
/** @type {Severity[]} indeks = severity syslog 0..7 */
const SYSLOG_SEV = ['critical', 'critical', 'critical', 'major', 'minor', 'info', 'info', 'info'];
const RE_5424 = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\]) ?(.*)$/s;
const RE_3164 = /^<(\d{1,3})>([A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}) (\S+) ([^:[\s]+)(?:\[\d+\])?: ?(.*)$/s;

/** @type {Parser} */
const nmsSyslog = (raw) => {
  const p = asObj(raw.payload);
  const line = String(p.message ?? '').trim();
  let pri = 13;
  let host = String(p.fromAddress ?? 'unknown');
  let app = null;
  let text = line;
  let ts;

  let m = RE_5424.exec(line);
  if (m) {
    pri = Number(m[1]);
    ts = m[2] !== '-' ? date(m[2]) : undefined;
    host = m[3] !== '-' ? m[3] : host;
    app = m[4] !== '-' ? m[4] : null;
    text = m[8];
  } else if ((m = RE_3164.exec(line))) {
    pri = Number(m[1]);
    host = m[3];
    app = m[4];
    text = m[5];
  }
  // Mnemonic gaya "%LINK-3-UPDOWN: ..." dipakai sebagai kode
  const mnemonic = /^%([A-Z0-9_]+-\d-[A-Z0-9_]+):/.exec(text);
  return [
    {
      kind: 'event',
      sourceKey: host,
      assetId: host,
      station: stationFromHost(host),
      category: 'log',
      severity: SYSLOG_SEV[pri % 8] ?? 'info',
      code: mnemonic ? mnemonic[1] : app ? `${app}.${pri % 8}` : `syslog.${pri % 8}`,
      message: text.slice(0, 2000) || '(pesan kosong)',
      state: 'info',
      ...(ts ? { sourceTs: ts } : {}),
    },
  ];
};

// =====================================================================
// PIDS: feed PIDC (arrival_update & disruption)
// =====================================================================
const PIDS_STATUS_TYPE = { ARRIVED: 'arrival', DEPARTED: 'departure', DELAYED: 'delay', ON_TIME: 'arrival' };

/** @type {Parser} */
const pidsPidcFeed = (raw) => {
  const p = asObj(raw.payload);

  if (p.type === 'disruption') {
    const active = p.active !== false;
    const stations = Array.isArray(p.stations) ? p.stations : [p.station].filter(Boolean);
    return stations.map((st) => ({
      kind: 'train_info',
      sourceKey: String(st),
      station: String(st),
      platform: null,
      trainNo: null,
      refId: str(p.disruptionId) ?? null,
      status: active ? 'DISRUPTION_ACTIVE' : 'DISRUPTION_CLEARED',
      direction: null,
      type: 'disruption',
      scheduledTs: null,
      estimatedTs: null,
      delaySec: null,
      message: active ? str(p.text) ?? 'Gangguan perjalanan' : `Normal kembali: ${str(p.text) ?? ''}`.trim(),
    }));
  }

  if (p.type === 'arrival_update') {
    const status = String(p.status ?? 'ON_TIME').toUpperCase();
    const delay = Number(p.delaySeconds ?? 0);
    let message = null;
    if (status === 'ARRIVED') message = 'Kereta tiba di peron';
    else if (status === 'DEPARTED') message = 'Kereta berangkat';
    else if (status === 'DELAYED') message = `Terlambat ${Math.round(delay / 60)} menit`;
    return [
      {
        kind: 'train_info',
        sourceKey: String(p.station),
        station: str(p.station),
        platform: str(p.platform) ?? null,
        trainNo: str(p.tripNo) ?? null,
        refId: str(p.tripNo) ?? null,
        status,
        direction: str(p.destination) ?? str(p.direction) ?? null,
        type: PIDS_STATUS_TYPE[status] ?? 'arrival',
        scheduledTs: date(p.scheduledArrival) ?? null,
        estimatedTs: date(p.estimatedArrival) ?? null,
        delaySec: Number.isFinite(delay) ? Math.round(delay) : null,
        message,
      },
    ];
  }
  return []; // tipe pesan lain (mis. info sistem) tidak dipetakan
};

// =====================================================================
// PIDS: JSON generik
// =====================================================================
const PIDS_TYPES = ['arrival', 'departure', 'delay', 'disruption'];
/** @type {Parser} */
const pidsGenericJson = (raw) => {
  const p = asObj(raw.payload);
  const rawType = String(pick(p, 'type', 'eventType', 'messageType') ?? '').toLowerCase();
  let type = 'arrival';
  if (PIDS_TYPES.includes(rawType)) type = rawType;
  else if (pick(p, 'disruption', 'disruptionMessage')) type = 'disruption';
  const delay = pick(p, 'delaySec', 'delay_sec', 'delay');
  return [
    {
      kind: 'train_info',
      sourceKey: String(pick(p, 'station', 'stationCode') ?? raw.sourceId),
      station: str(pick(p, 'station', 'stationCode', 'station_code')),
      platform: str(pick(p, 'platform', 'platformNumber', 'platform_no')) ?? null,
      trainNo: str(pick(p, 'trainNo', 'train_no', 'trainNumber', 'train')) ?? null,
      refId: str(pick(p, 'tripId', 'trainNo', 'train_no', 'id')) ?? null,
      status: str(pick(p, 'status')) ?? null,
      direction: str(pick(p, 'direction', 'destination', 'bound')) ?? null,
      type,
      scheduledTs: date(pick(p, 'scheduled', 'scheduledTime', 'scheduled_ts')) ?? null,
      estimatedTs: date(pick(p, 'estimated', 'estimatedTime', 'eta', 'estimated_ts')) ?? null,
      delaySec: delay === undefined ? null : Number(delay),
      message: str(pick(p, 'message', 'text', 'disruptionMessage')) ?? null,
    },
  ];
};

/** @type {Record<string, Parser>} */
const parsers = {
  'scada-opcua': scadaOpcua,
  'nms-snmp-trap': nmsSnmpTrap,
  'nms-generic-json': nmsGenericJson,
  'nms-syslog': nmsSyslog,
  'pids-pidc-feed': pidsPidcFeed,
  'pids-generic-json': pidsGenericJson,
};

/** @returns {Parser} */
function getParser(name) {
  const p = parsers[name];
  if (!p) throw new Error(`Unknown parser: ${name}. Tersedia: ${Object.keys(parsers).join(', ')}`);
  return p;
}

module.exports = { parsers, getParser };

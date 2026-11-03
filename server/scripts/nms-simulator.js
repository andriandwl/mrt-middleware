'use strict';

/**
 * Simulator DTS / Telecommunication NMS (DUMMY): mengirim SNMP v2c trap dan syslog (RFC 5424)
 * ke middleware, berdasarkan data/nms-devices.csv dan data/nms-traps.csv.
 *
 * Perilaku:
 *  - Alarm acak per perangkat sesuai tipe (bobot di katalog), aktif 1–20 menit lalu dikirim trap clear-nya.
 *  - linkDown/linkUp disertai syslog LINK-3-UPDOWN, seperti perangkat jaringan sungguhan.
 *  - Syslog rutin (login, sinkron NTP, konfigurasi disimpan, peringatan suhu) ±1 pesan / 3 detik.
 *  - Trap membawa varbind snmpTrapAddress.0 (IP perangkat asli) dan sysName.0, seperti trap yang
 *    diteruskan NMS (RFC 3584), sehingga middleware bisa mengenali perangkat walau trap dari 1 host.
 *
 * Env: NMS_TARGET_HOST (127.0.0.1), NMS_TRAP_PORT (1162), NMS_SYSLOG_PORT (5514),
 *      NMS_COMMUNITY (public), SIM_ALARM_RATE (pengali frekuensi, default 1)
 */

const dgram = require('node:dgram');
const path = require('node:path');
const snmp = require('net-snmp');
const { readCsvFile } = require('../src/core/csv');
const { VARBINDS } = require('./generate-nms-catalog');

const DATA = path.join(__dirname, '..', 'data');
const HOST = process.env.NMS_TARGET_HOST || '127.0.0.1';
const TRAP_PORT = Number(process.env.NMS_TRAP_PORT || 1162);
const SYSLOG_PORT = Number(process.env.NMS_SYSLOG_PORT || 5514);
const COMMUNITY = process.env.NMS_COMMUNITY || 'public';
const RATE = Number(process.env.SIM_ALARM_RATE || 1);

const devices = readCsvFile(path.join(DATA, 'nms-devices.csv'));
const traps = readCsvFile(path.join(DATA, 'nms-traps.csv'));
const trapById = Object.fromEntries(traps.map((t) => [t.trap_id, t]));
const clearFor = Object.fromEntries(traps.filter((t) => t.clears).map((t) => [t.clears, t]));
const raisable = traps.filter((t) => Number(t.weight) > 0);

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const appliesTo = (trap, device) => trap.device_types === '*' || trap.device_types.split('|').includes(device.device_type);

function ifDescr(device, idx) {
  if (device.device_type.startsWith('dts_')) return `GigabitEthernet1/0/${idx}`;
  return `eth${idx - 1}`;
}

const COMPONENTS = {
  psu_fail: ['PSU-1', 'PSU-2'],
  fan_fail: ['FAN-1', 'FAN-2', 'FAN-3'],
  disk_fail: ['Disk-1', 'Disk-2', 'Disk-3', 'Disk-4'],
  radio_carrier_down: ['Carrier-1', 'Carrier-2'],
  pa_amp_fault: ['AMP-1', 'AMP-2'],
  display_offline: ['Peron-1', 'Peron-2', 'Concourse-1', 'Concourse-2'],
};

// ---------- pengirim ----------
// Catatan: net-snmp mengirim trap ke `trapPort` (default 162), bukan `port`
const session = snmp.createSession(HOST, COMMUNITY, { trapPort: TRAP_PORT, version: snmp.Version2c });
session.on('error', (err) => console.error('snmp session error', err.message));
const syslogSocket = dgram.createSocket('udp4');

function sendTrap(trap, device, ctx) {
  const vb = [
    { oid: VARBINDS.snmpTrapAddress, type: snmp.ObjectType.IpAddress, value: device.ip },
    { oid: VARBINDS.sysName, type: snmp.ObjectType.OctetString, value: device.hostname },
  ];
  if (ctx.ifIndex !== undefined) {
    vb.push(
      { oid: `${VARBINDS.ifIndex}.${ctx.ifIndex}`, type: snmp.ObjectType.Integer, value: ctx.ifIndex },
      { oid: `${VARBINDS.ifDescr}.${ctx.ifIndex}`, type: snmp.ObjectType.OctetString, value: ctx.ifDescr },
      { oid: `${VARBINDS.ifOperStatus}.${ctx.ifIndex}`, type: snmp.ObjectType.Integer, value: trap.state === 'cleared' ? 1 : 2 },
    );
  }
  if (ctx.value !== undefined) vb.push({ oid: VARBINDS.value, type: snmp.ObjectType.Integer, value: ctx.value });
  if (ctx.threshold !== undefined) vb.push({ oid: VARBINDS.threshold, type: snmp.ObjectType.Integer, value: ctx.threshold });
  if (ctx.component) vb.push({ oid: VARBINDS.component, type: snmp.ObjectType.OctetString, value: ctx.component });
  if (ctx.peer) vb.push({ oid: VARBINDS.peer, type: snmp.ObjectType.OctetString, value: ctx.peer });
  session.trap(trap.trap_oid, vb, (err) => {
    if (err) console.error('trap send error', err.message);
  });
}

/** RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG ; facility local7 (23) */
function sendSyslog(device, severity, app, msg) {
  const pri = 23 * 8 + severity;
  const line = `<${pri}>1 ${new Date().toISOString()} ${device.hostname} ${app} - - - ${msg}`;
  syslogSocket.send(Buffer.from(line), SYSLOG_PORT, HOST);
}

// ---------- alarm aktif ----------
/** key → { trap, device, ctx, until } */
const active = new Map();
let raised = 0;
let cleared = 0;
let logs = 0;

function raiseRandom() {
  // pilih trap berbobot, lalu perangkat yang cocok
  const total = raisable.reduce((s, t) => s + Number(t.weight), 0);
  let r = Math.random() * total;
  const trap = raisable.find((t) => (r -= Number(t.weight)) < 0) ?? raisable[0];
  const device = pick(devices.filter((d) => appliesTo(trap, d)));
  if (!device) return;

  const ctx = {};
  if (trap.key_varbind === 'ifIndex' || trap.trap_id === 'link_down') {
    ctx.ifIndex = randInt(1, Number(device.interfaces) || 1);
    ctx.ifDescr = ifDescr(device, ctx.ifIndex);
  }
  if (trap.trap_id === 'cpu_high') Object.assign(ctx, { value: randInt(86, 99), threshold: 85 });
  if (trap.trap_id === 'temp_high') Object.assign(ctx, { value: randInt(61, 72), threshold: 60 });
  if (COMPONENTS[trap.trap_id]) ctx.component = pick(COMPONENTS[trap.trap_id]);
  if (trap.trap_id === 'auth_fail') ctx.peer = `10.20.${randInt(1, 13)}.${randInt(100, 200)}`;

  if (trap.state !== 'active') {
    sendTrap(trap, device, ctx);
    if (trap.trap_id === 'cold_start') sendSyslog(device, 5, 'SYS', '%SYS-5-RESTART: System restarted');
    raised += 1;
    return;
  }

  const key = `${device.device_id}|${trap.trap_id}|${ctx.ifIndex ?? ctx.component ?? ''}`;
  if (active.has(key)) return;
  active.set(key, { trap, device, ctx, until: Date.now() + rand(1, 20) * 60_000 });
  sendTrap(trap, device, ctx);
  if (trap.trap_id === 'link_down') {
    sendSyslog(device, 3, 'LINK', `%LINK-3-UPDOWN: Interface ${ctx.ifDescr}, changed state to down`);
  }
  raised += 1;
}

function clearExpired() {
  const now = Date.now();
  for (const [key, a] of active) {
    if (a.until > now) continue;
    const clearTrap = clearFor[a.trap.trap_id];
    const ctx = { ...a.ctx };
    if (a.trap.trap_id === 'cpu_high') ctx.value = randInt(30, 60);
    if (a.trap.trap_id === 'temp_high') ctx.value = randInt(40, 52);
    if (clearTrap) sendTrap(clearTrap, a.device, ctx);
    if (a.trap.trap_id === 'link_down') {
      sendSyslog(a.device, 3, 'LINK', `%LINK-3-UPDOWN: Interface ${ctx.ifDescr}, changed state to up`);
    }
    active.delete(key);
    cleared += 1;
  }
}

const ROUTINE_LOGS = [
  [6, 'SSH', (d) => `%SSH-6-LOGIN: User noc-admin logged in from 10.20.100.${randInt(21, 40)}`],
  [6, 'SSH', () => '%SSH-6-LOGOUT: User noc-admin logged out'],
  [6, 'NTP', () => '%NTP-6-SYNC: Clock synchronized to 10.20.100.5 stratum 2'],
  [5, 'SYS', () => '%SYS-5-CONFIG_I: Configuration saved by noc-admin'],
  [4, 'ENVMON', () => `%ENVMON-4-TEMP: Temperature ${randInt(52, 58)}C approaching threshold 60C`],
  [6, 'SNMP', () => '%SNMP-6-POLL: Periodic poll from NMS 10.20.100.21 completed'],
  [4, 'STP', (d) => `%STP-4-TOPOLOGY: Topology change detected on ${ifDescr(d, randInt(1, 24))}`],
];

function routineLog() {
  const device = pick(devices);
  const [sev, app, make] = pick(ROUTINE_LOGS);
  sendSyslog(device, sev, app, make(device));
  logs += 1;
}

// ---------- loop ----------
const TICK_MS = 2000;
setInterval(() => {
  clearExpired();
  if (Math.random() < 0.1 * RATE) raiseRandom(); // ±1 trap / 20 dtk pada RATE=1
  if (Math.random() < 0.6) routineLog(); // ±1 syslog / 3 dtk
}, TICK_MS);

setInterval(() => {
  console.log(`[nms-sim] trap raise ${raised}, clear ${cleared}, aktif ${active.size}, syslog ${logs}`);
}, 60_000);

console.log(
  `NMS simulator: ${devices.length} perangkat, ${traps.length} jenis trap → trap udp://${HOST}:${TRAP_PORT}, syslog udp://${HOST}:${SYSLOG_PORT}, alarm rate ×${RATE}`,
);

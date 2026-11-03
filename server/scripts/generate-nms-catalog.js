'use strict';

/**
 * Generator katalog DTS / Telecommunication NMS (DUMMY REALISTIS).
 *
 * Output:
 *   data/nms-devices.csv   perangkat telekomunikasi per stasiun + OCC (hostname, IP, tipe)
 *   data/nms-traps.csv     katalog SNMP trap: OID, severity, kategori, pasangan raise/clear, template pesan
 *   data/nms-mappings.csv  untuk tag_mappings (source=nms): IP & hostname → asset_id + stasiun
 *
 * Yang ASUMSI (ganti setelah spesifikasi dari tim DTS tersedia):
 *   tipe & jumlah perangkat per stasiun, rencana IP 10.20.x.x, konvensi hostname, OID enterprise,
 *   severity tiap trap. OID enterprise memakai PEN 32473 (dicadangkan untuk dokumentasi, RFC 5612).
 *   OID linkDown/linkUp/coldStart/authenticationFailure adalah OID standar SNMPv2 (RFC 3418 / 2863).
 *
 * Pemakaian: npm run nms:generate
 */

const fs = require('node:fs');
const path = require('node:path');
const { toCsv } = require('../src/core/csv');
const { STATIONS } = require('./generate-scada-tags');

const { ENT, VARBINDS } = require('../src/parsers/snmp-oids'); // enterprise dummy & OID varbind

/** [type, kode di hostname, jumlah layang, jumlah bawah tanah, interface, deskripsi] */
const STATION_DEVICES = [
  ['dts_core_switch', 'CSW', 2, 2, 24, 'DTS core switch (ring backbone)'],
  ['dts_access_switch', 'ASW', 3, 4, 48, 'DTS access switch'],
  ['radio_base_station', 'TBS', 1, 1, 4, 'Radio base station (TETRA)'],
  ['cctv_nvr', 'NVR', 1, 1, 4, 'CCTV network video recorder'],
  ['pa_controller', 'PAC', 1, 1, 2, 'Public address controller'],
  ['clock_slave', 'CLK', 1, 1, 1, 'Master clock slave'],
  ['pids_display_ctrl', 'PDC', 1, 1, 2, 'PIDS display controller'],
];
const OCC_DEVICES = [
  ['dts_core_router', 'CRT', 2, 48, 'DTS core router OCC'],
  ['dts_core_switch', 'CSW', 2, 48, 'DTS core switch OCC'],
  ['nms_server', 'NMS', 1, 2, 'NMS server'],
  ['radio_switch', 'TSW', 1, 8, 'TETRA switching & management'],
];

const DEVICE_COLUMNS = ['device_id', 'hostname', 'ip', 'station_code', 'station_name', 'device_type', 'interfaces', 'description'];

function buildDevices() {
  const rows = [];
  const add = (stationIdx, code, name, type, short, n, ifaces, desc) => {
    for (let i = 1; i <= n; i += 1) {
      const host = `${code}-${short}${String(i).padStart(2, '0')}`;
      rows.push({
        device_id: host,
        hostname: host,
        ip: `10.20.${stationIdx}.${rows.filter((r) => r.station_code === code).length + 11}`,
        station_code: code,
        station_name: name,
        device_type: type,
        interfaces: ifaces,
        description: `${desc} ${i}`,
      });
    }
  };
  STATIONS.forEach(([code, name, type], idx) => {
    for (const [dt, short, nEl, nUg, ifaces, desc] of STATION_DEVICES) {
      add(idx + 1, code, name, dt, short, type === 'underground' ? nUg : nEl, ifaces, desc);
    }
  });
  for (const [dt, short, n, ifaces, desc] of OCC_DEVICES) add(100, 'OCC', 'Operation Control Center', dt, short, n, ifaces, desc);
  return rows;
}

const TRAP_COLUMNS = [
  'trap_id',
  'trap_oid',
  'name',
  'device_types',
  'category',
  'severity',
  'state',
  'clears',
  'key_varbind',
  'message',
  'weight',
  'description',
];

/**
 * state: active (raise) | cleared (clear) | info (sekali kejadian).
 * clears: trap_id yang dibersihkan oleh trap ini. key_varbind: varbind yang membedakan instans alarm (mis. ifIndex).
 * message: template; {ifIndex} {ifDescr} {value} {threshold} {component} {peer} diisi dari varbind.
 * weight: bobot relatif kemunculan di simulator.
 */
const TRAPS = [
  ['link_down', '1.3.6.1.6.3.1.1.5.3', 'linkDown', '*', 'alarm', 'major', 'active', '', 'ifIndex', 'Port {ifDescr} down', 10, 'Interface operasional down (standar SNMPv2)'],
  ['link_up', '1.3.6.1.6.3.1.1.5.4', 'linkUp', '*', 'alarm', 'info', 'cleared', 'link_down', 'ifIndex', 'Port {ifDescr} up', 0, 'Interface kembali up (standar SNMPv2)'],
  ['cold_start', '1.3.6.1.6.3.1.1.5.1', 'coldStart', '*', 'device_event', 'minor', 'info', '', '', 'Perangkat restart (cold start)', 2, 'Perangkat menyala ulang'],
  ['auth_fail', '1.3.6.1.6.3.1.1.5.5', 'authenticationFailure', '*', 'device_event', 'minor', 'info', '', '', 'Autentikasi SNMP gagal dari {peer}', 2, 'Akses SNMP dengan community/kredensial salah'],
  ['cpu_high', `${ENT}.0.1`, 'cpuUtilizationHigh', 'dts_core_switch|dts_access_switch|dts_core_router', 'alarm', 'minor', 'active', '', '', 'CPU {value}% melewati ambang {threshold}%', 6, 'Utilisasi CPU tinggi'],
  ['cpu_normal', `${ENT}.0.2`, 'cpuUtilizationNormal', 'dts_core_switch|dts_access_switch|dts_core_router', 'alarm', 'info', 'cleared', 'cpu_high', '', 'CPU kembali normal ({value}%)', 0, 'Utilisasi CPU normal'],
  ['temp_high', `${ENT}.0.3`, 'temperatureHigh', '*', 'alarm', 'major', 'active', '', '', 'Suhu perangkat {value}°C melewati ambang {threshold}°C', 3, 'Suhu perangkat tinggi'],
  ['temp_normal', `${ENT}.0.4`, 'temperatureNormal', '*', 'alarm', 'info', 'cleared', 'temp_high', '', 'Suhu perangkat kembali normal ({value}°C)', 0, 'Suhu perangkat normal'],
  ['psu_fail', `${ENT}.0.5`, 'powerSupplyFailed', 'dts_core_switch|dts_core_router|cctv_nvr|nms_server', 'alarm', 'major', 'active', '', 'component', '{component} gagal', 2, 'Power supply gagal (redundan)'],
  ['psu_ok', `${ENT}.0.6`, 'powerSupplyRestored', 'dts_core_switch|dts_core_router|cctv_nvr|nms_server', 'alarm', 'info', 'cleared', 'psu_fail', 'component', '{component} normal kembali', 0, 'Power supply pulih'],
  ['fan_fail', `${ENT}.0.7`, 'fanFailed', 'dts_core_switch|dts_access_switch|dts_core_router|cctv_nvr', 'alarm', 'minor', 'active', '', 'component', '{component} berhenti', 3, 'Kipas perangkat gagal'],
  ['fan_ok', `${ENT}.0.8`, 'fanRestored', 'dts_core_switch|dts_access_switch|dts_core_router|cctv_nvr', 'alarm', 'info', 'cleared', 'fan_fail', 'component', '{component} normal kembali', 0, 'Kipas pulih'],
  ['ring_break', `${ENT}.0.9`, 'ringProtectionSwitched', 'dts_core_switch', 'alarm', 'critical', 'active', '', '', 'Ring backbone terputus, jalur berpindah ke proteksi', 1, 'Ring DTS terputus (protection switching)'],
  ['ring_restore', `${ENT}.0.10`, 'ringRestored', 'dts_core_switch', 'alarm', 'info', 'cleared', 'ring_break', '', 'Ring backbone pulih', 0, 'Ring DTS pulih'],
  ['disk_fail', `${ENT}.0.11`, 'storageDiskFailed', 'cctv_nvr|nms_server', 'alarm', 'major', 'active', '', 'component', '{component} gagal, RAID degraded', 2, 'Disk penyimpanan gagal'],
  ['disk_ok', `${ENT}.0.12`, 'storageDiskRebuilt', 'cctv_nvr|nms_server', 'alarm', 'info', 'cleared', 'disk_fail', 'component', '{component} selesai rebuild', 0, 'Disk pulih'],
  ['radio_carrier_down', `${ENT}.0.13`, 'radioCarrierDown', 'radio_base_station', 'alarm', 'critical', 'active', '', 'component', 'Carrier radio {component} down', 1, 'Carrier base station radio down'],
  ['radio_carrier_up', `${ENT}.0.14`, 'radioCarrierUp', 'radio_base_station', 'alarm', 'info', 'cleared', 'radio_carrier_down', 'component', 'Carrier radio {component} up', 0, 'Carrier radio pulih'],
  ['clock_sync_lost', `${ENT}.0.15`, 'clockSyncLost', 'clock_slave', 'alarm', 'minor', 'active', '', '', 'Sinkronisasi waktu ke master clock hilang', 2, 'Clock slave kehilangan sinkronisasi'],
  ['clock_sync_ok', `${ENT}.0.16`, 'clockSyncRestored', 'clock_slave', 'alarm', 'info', 'cleared', 'clock_sync_lost', '', 'Sinkronisasi waktu pulih', 0, 'Clock slave tersinkron kembali'],
  ['pa_amp_fault', `${ENT}.0.17`, 'paAmplifierFault', 'pa_controller', 'alarm', 'major', 'active', '', 'component', 'Amplifier PA {component} fault', 2, 'Amplifier public address fault'],
  ['pa_amp_ok', `${ENT}.0.18`, 'paAmplifierRestored', 'pa_controller', 'alarm', 'info', 'cleared', 'pa_amp_fault', 'component', 'Amplifier PA {component} normal kembali', 0, 'Amplifier PA pulih'],
  ['display_offline', `${ENT}.0.19`, 'pidsDisplayOffline', 'pids_display_ctrl', 'alarm', 'minor', 'active', '', 'component', 'Display PIDS {component} offline', 3, 'Display PIDS tidak merespons'],
  ['display_online', `${ENT}.0.20`, 'pidsDisplayOnline', 'pids_display_ctrl', 'alarm', 'info', 'cleared', 'display_offline', 'component', 'Display PIDS {component} online', 0, 'Display PIDS kembali online'],
];

function buildTraps() {
  return TRAPS.map(([trap_id, trap_oid, name, device_types, category, severity, state, clears, key_varbind, message, weight, description]) => ({
    trap_id,
    trap_oid,
    name,
    device_types,
    category,
    severity,
    state,
    clears,
    key_varbind,
    message,
    weight,
    description,
  }));
}

function buildMappings(devices) {
  const rows = [];
  for (const d of devices) {
    for (const key of [d.ip, d.hostname]) {
      rows.push({ source_key: key, station_code: d.station_code, asset_id: d.device_id, metric: 'device', unit: '' });
    }
  }
  return rows;
}

if (require.main === module) {
  const dir = path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const devices = buildDevices();
  const traps = buildTraps();
  fs.writeFileSync(path.join(dir, 'nms-devices.csv'), toCsv(DEVICE_COLUMNS, devices));
  fs.writeFileSync(path.join(dir, 'nms-traps.csv'), toCsv(TRAP_COLUMNS, traps));
  fs.writeFileSync(
    path.join(dir, 'nms-mappings.csv'),
    toCsv(['source_key', 'station_code', 'asset_id', 'metric', 'unit'], buildMappings(devices)),
  );
  const byType = devices.reduce((a, d) => ({ ...a, [d.device_type]: (a[d.device_type] ?? 0) + 1 }), {});
  console.log(`wrote ${devices.length} devices, ${traps.length} trap types → data/nms-*.csv`);
  console.log(byType);
}

module.exports = { buildDevices, buildTraps, VARBINDS, ENT };

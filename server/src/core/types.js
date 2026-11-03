'use strict';

/**
 * Definisi tipe (JSDoc) untuk seluruh project. File ini tidak berisi logika;
 * editor seperti VS Code memakai anotasi ini untuk autocomplete dan pengecekan ringan.
 *
 * @typedef {'scada' | 'nms' | 'pids'} SourceSystem
 * @typedef {'good' | 'uncertain' | 'bad'} Quality
 * @typedef {'info' | 'minor' | 'major' | 'critical'} Severity
 *
 * Record mentah dari konektor, sebelum parsing.
 * @typedef {Object} RawRecord
 * @property {SourceSystem} source
 * @property {string} connectorId
 * @property {string} sourceId      Identitas record di sistem sumber (nodeId, alarm id, OID, dll.)
 * @property {Date} sourceTs
 * @property {Date} receivedTs
 * @property {unknown} payload
 * @property {string} correlationId
 *
 * ---------- Canonical model ----------
 *
 * @typedef {Object} TelemetryRecord
 * @property {'telemetry'} kind
 * @property {SourceSystem} source
 * @property {string} assetId
 * @property {string} station
 * @property {string} metric
 * @property {number|null} valueNum
 * @property {string|null} valueText
 * @property {string|null} unit
 * @property {Quality} quality
 * @property {Date} sourceTs
 * @property {Date} receivedTs
 *
 * @typedef {Object} EventRecord
 * @property {'event'} kind
 * @property {SourceSystem} source
 * @property {string} assetId
 * @property {string} station
 * @property {'alarm'|'status_change'|'device_event'|'log'} category
 * @property {Severity} severity
 * @property {string|null} code
 * @property {string} message
 * @property {'active'|'cleared'|'info'} state
 * @property {string|null} [alarmKey]  pasangan raise/clear; sama untuk alarm & clear-nya
 * @property {Date} sourceTs
 * @property {Date} receivedTs
 *
 * @typedef {Object} TrainInfoRecord
 * @property {'train_info'} kind
 * @property {'pids'} source
 * @property {string} station
 * @property {string|null} platform
 * @property {string|null} trainNo
 * @property {string|null} [refId]   ID perjalanan (trip) atau ID gangguan
 * @property {string|null} [status]  status mentah PIDC: ON_TIME|DELAYED|ARRIVED|DEPARTED|DISRUPTION_ACTIVE|DISRUPTION_CLEARED
 * @property {string|null} direction
 * @property {'arrival'|'departure'|'delay'|'disruption'} type
 * @property {Date|null} scheduledTs
 * @property {Date|null} estimatedTs
 * @property {number|null} delaySec
 * @property {string|null} message
 * @property {Date} sourceTs
 * @property {Date} receivedTs
 *
 * @typedef {TelemetryRecord | EventRecord | TrainInfoRecord} CanonicalRecord
 *
 * Hasil parser sebelum mapping. `sourceKey` dipakai untuk mencari tag_mappings.
 * Field canonical yang sudah diketahui parser boleh diisi langsung; sisanya diisi Mapper.
 * @typedef {Object} DraftRecord
 * @property {'telemetry'|'event'|'train_info'} kind
 * @property {string} sourceKey
 * @property {unknown} [rawValue]
 *
 * @typedef {(raw: RawRecord) => DraftRecord[]} Parser
 *
 * ---------- Konektor ----------
 *
 * @typedef {'idle'|'connecting'|'connected'|'disconnected'|'error'|'stopped'} ConnectorState
 *
 * @typedef {Object} ConnectorStatus
 * @property {string} id
 * @property {SourceSystem} source
 * @property {string} type
 * @property {ConnectorState} state
 * @property {string|null} lastError
 * @property {Date|null} lastRecordTs
 * @property {number} reconnectAttempts
 *
 * Kontrak semua konektor. Konektor HANYA membaca/menerima dari sumber:
 * tidak ada method untuk menulis, mengirim perintah, atau mengubah konfigurasi sumber.
 * Events: 'record' (RawRecord), 'status' (ConnectorStatus)
 * @typedef {import('node:events').EventEmitter & {
 *   id: string,
 *   source: SourceSystem,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   status(): ConnectorStatus
 * }} SourceConnector
 */

module.exports = {};

'use strict';

const { OpcUaConnector } = require('./opcua.connector');
const { HttpPollConnector } = require('./http-poll.connector');
const { WebhookConnector } = require('./webhook.connector');
const { SyslogConnector } = require('./syslog.connector');
const { SnmpTrapConnector } = require('./snmp-trap.connector');
const { WebSocketClientConnector } = require('./websocket-client.connector');

/** Tambahkan tipe baru di sini (dan di enum `type` pada config.js). */
const CONNECTOR_TYPES = {
  opcua: OpcUaConnector,
  'http-poll': HttpPollConnector,
  webhook: WebhookConnector,
  syslog: SyslogConnector,
  'snmp-trap': SnmpTrapConnector,
  'websocket-client': WebSocketClientConnector,
};

/**
 * @param {import('../config').ConnectorConfig} config
 * @returns {import('../core/types').SourceConnector}
 */
function createConnector(config) {
  const Ctor = CONNECTOR_TYPES[config.type];
  if (!Ctor) throw new Error(`Unknown connector type: ${config.type}`);
  return new Ctor(config);
}

module.exports = { createConnector, CONNECTOR_TYPES };

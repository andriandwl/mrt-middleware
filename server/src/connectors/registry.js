import { OpcUaConnector } from './opcua.connector.js';
import { HttpPollConnector } from './http-poll.connector.js';
import { WebhookConnector } from './webhook.connector.js';
import { SyslogConnector } from './syslog.connector.js';
import { SnmpTrapConnector } from './snmp-trap.connector.js';
import { WebSocketClientConnector } from './websocket-client.connector.js';

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
 * @param {import('../config.js').ConnectorConfig} config
 * @returns {import('../core/types.js').SourceConnector}
 */
function createConnector(config) {
  const Ctor = CONNECTOR_TYPES[config.type];
  if (!Ctor) throw new Error(`Unknown connector type: ${config.type}`);
  return new Ctor(config);
}

export { createConnector, CONNECTOR_TYPES };

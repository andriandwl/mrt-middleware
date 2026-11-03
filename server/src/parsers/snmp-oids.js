'use strict';

/** OID varbind yang dipakai katalog trap NMS, simulator, dan parser. */
const ENT = '1.3.6.1.4.1.32473.1'; // enterprise dummy (PEN 32473 = dokumentasi, RFC 5612)

const VARBINDS = {
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  snmpTrapOID: '1.3.6.1.6.3.1.1.4.1.0',
  snmpTrapAddress: '1.3.6.1.6.3.18.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  ifIndex: '1.3.6.1.2.1.2.2.1.1',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  value: `${ENT}.2.1`,
  threshold: `${ENT}.2.2`,
  component: `${ENT}.2.3`,
  peer: `${ENT}.2.4`,
};

module.exports = { ENT, VARBINDS };

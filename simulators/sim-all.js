/**
 * Jalankan ketiga simulator sekaligus: Facility SCADA (OPC UA), DTS/NMS (SNMP trap + syslog), PIDC (WebSocket feed).
 * Pemakaian: npm run sim:all    (Ctrl+C menghentikan semuanya)
 * Env diteruskan ke tiap simulator, mis. SIM_ALARM_RATE=10 npm run sim:all
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIMS = [
  ['scada', path.join(__dirname, 'scada', 'opcua-simulator.js')],
  ['nms', path.join(__dirname, 'nms', 'nms-simulator.js')],
  ['pids', path.join(__dirname, 'pids', 'pids-simulator.js')],
];

const children = SIMS.map(([name, file]) => {
  const child = spawn(process.execPath, [file], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}]`.padEnd(8);
  const pipe = (stream, out) =>
    stream.on('data', (buf) =>
      buf
        .toString()
        .split('\n')
        .filter(Boolean)
        .forEach((line) => out.write(`${prefix}${line}\n`)),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}berhenti (kode ${code})`));
  return child;
});

const stop = () => {
  children.forEach((c) => c.kill('SIGTERM'));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

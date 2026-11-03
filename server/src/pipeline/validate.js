'use strict';

const { z } = require('zod');

const MAX_FUTURE_MS = 5 * 60_000; // toleransi clock skew 5 menit
const MAX_PAST_MS = 7 * 24 * 3600_000; // tolak data lebih tua dari 7 hari

const ts = z.date().refine(
  (d) => {
    const diff = d.getTime() - Date.now();
    return diff <= MAX_FUTURE_MS && diff >= -MAX_PAST_MS;
  },
  { message: 'timestamp di luar rentang wajar' },
);

const base = {
  source: z.enum(['scada', 'nms', 'pids']),
  sourceTs: ts,
  receivedTs: z.date(),
};

const telemetry = z
  .object({
    kind: z.literal('telemetry'),
    ...base,
    assetId: z.string().min(1).max(200),
    station: z.string().min(1).max(50),
    metric: z.string().min(1).max(100),
    valueNum: z.number().finite().nullable(),
    valueText: z.string().max(1000).nullable(),
    unit: z.string().max(30).nullable(),
    quality: z.enum(['good', 'uncertain', 'bad']),
  })
  .refine((r) => r.valueNum !== null || r.valueText !== null, { message: 'telemetry tanpa nilai' });

const event = z.object({
  kind: z.literal('event'),
  ...base,
  assetId: z.string().min(1).max(200),
  station: z.string().min(1).max(50),
  category: z.enum(['alarm', 'status_change', 'device_event', 'log']),
  severity: z.enum(['info', 'minor', 'major', 'critical']),
  code: z.string().max(100).nullable(),
  message: z.string().min(1).max(2000),
  state: z.enum(['active', 'cleared', 'info']),
  alarmKey: z.string().max(300).nullable().default(null),
});

const trainInfo = z.object({
  kind: z.literal('train_info'),
  ...base,
  source: z.literal('pids'),
  station: z.string().min(1).max(50),
  platform: z.string().max(20).nullable(),
  trainNo: z.string().max(30).nullable(),
  refId: z.string().max(60).nullable().default(null),
  status: z.string().max(30).nullable().default(null),
  direction: z.string().max(100).nullable(),
  type: z.enum(['arrival', 'departure', 'delay', 'disruption']),
  scheduledTs: z.date().nullable(),
  estimatedTs: z.date().nullable(),
  delaySec: z.number().int().min(-3600).max(86_400).nullable(),
  message: z.string().max(2000).nullable(),
});

const canonical = z.union([telemetry, event, trainInfo]);

/**
 * @param {unknown} record
 * @returns {{ ok: true, record: import('../core/types').CanonicalRecord } | { ok: false, reason: string }}
 */
function validate(record) {
  const r = canonical.safeParse(record);
  if (r.success) return { ok: true, record: r.data };
  const reason = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { ok: false, reason };
}

module.exports = { validate };

"use strict";

/**
 * Skema request & response API konsumen — SATU sumber untuk validasi di routes.js DAN dokumentasi OpenAPI
 * (src/api/openapi.js). Mengubah skema di sini otomatis memperbarui /openapi.json dan /docs.
 */

const { z } = require("zod");
const { extendZodWithOpenApi } = require("@asteasolutions/zod-to-openapi");

extendZodWithOpenApi(z);

// ---------- parameter umum ----------
const SOURCES = ["scada", "nms", "pids"];
const SEVERITIES = ["info", "minor", "major", "critical"];
const CATEGORIES = ["alarm", "status_change", "device_event", "log"];
const TRAIN_TYPES = ["arrival", "departure", "delay", "disruption"];

const dateParam = (description) =>
  z.coerce
    .date()
    .optional()
    .openapi({
      type: "string",
      format: "date-time",
      description,
      example: "2026-10-29T00:00:00+07:00",
    });
const limitParam = (def, max) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .default(def)
    .openapi({
      description: `Jumlah baris maksimum (default ${def}, maks ${max})`,
    });

const source = z
  .enum(SOURCES)
  .optional()
  .openapi({ description: "Sistem sumber" });
const severity = z
  .enum(SEVERITIES)
  .optional()
  .openapi({ description: "Tingkat keparahan" });
const station = z
  .string()
  .max(50)
  .transform((s) => s.toUpperCase())
  .optional()
  .openapi({
    type: "string",
    description: "Kode stasiun 3 huruf (mis. LBB, BHI)",
    example: "LBB",
  });
const from = dateParam("Mulai (inklusif), ISO 8601");
const to = dateParam("Sampai (inklusif), ISO 8601");

// ---------- query per endpoint ----------
const telemetryQuery = z.object({
  source,
  station,
  assetId: z
    .string()
    .optional()
    .openapi({ description: "ID aset, mis. LBB-AHU-01" }),
  metric: z
    .string()
    .optional()
    .openapi({ description: "Nama metric, mis. supply_temp" }),
  from,
  to,
  limit: limitParam(500, 5000),
});

const telemetryHourlyQuery = telemetryQuery.extend({
  limit: limitParam(1000, 10_000),
});

const latestQuery = z.object({ source, station });

const eventsQuery = z.object({
  source,
  station,
  severity,
  state: z
    .enum(["active", "cleared", "info"])
    .optional()
    .openapi({ description: "Status event" }),
  category: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.enum(CATEGORIES)).optional())
    .openapi({
      type: "string",
      description: `Satu atau beberapa kategori dipisah koma: ${CATEGORIES.join(", ")}`,
      example: "alarm,device_event",
    }),
  from,
  to,
  limit: limitParam(500, 5000),
});

const activeAlarmsQuery = z.object({
  source,
  station,
  severity,
  limit: limitParam(1000, 5000),
});

const trainInfoQuery = z.object({
  station,
  platform: z
    .string()
    .max(20)
    .optional()
    .openapi({ description: "Nomor peron" }),
  type: z.enum(TRAIN_TYPES).optional().openapi({ description: "Jenis pesan" }),
  from,
  to,
  limit: limitParam(500, 5000),
});

const boardQuery = z.object({
  station,
  perPlatform: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .openapi({ description: "Jumlah kereta berikutnya per peron" }),
});

const mappingsQuery = z.object({ source });

const mappingBody = z
  .object({
    source: z.enum(SOURCES),
    sourceKey: z
      .string()
      .min(1)
      .max(300)
      .openapi({
        description: "nodeId OPC UA, IP/hostname perangkat, dll.",
        example: "ns=2;s=LBB.ECS.AHU01.SupplyTemp",
      }),
    assetId: z.string().min(1).max(200).openapi({ example: "LBB-AHU-01" }),
    station: z
      .string()
      .min(1)
      .max(50)
      .transform((s) => s.toUpperCase())
      .openapi({ type: "string", example: "LBB" }),
    metric: z.string().min(1).max(100).openapi({ example: "supply_temp" }),
    unit: z
      .string()
      .max(30)
      .nullable()
      .default(null)
      .openapi({ example: "°C" }),
    scale: z
      .number()
      .finite()
      .default(1)
      .openapi({ description: "Pengali nilai mentah" }),
    active: z.boolean().default(true),
  })
  .openapi("TagMappingInput");

const SCOPE_RE = /^(\*|scada|nms|pids):(\*|[A-Za-z0-9]{2,10})$/;
const ssoMappingBody = z
  .object({
    claimType: z
      .enum(["role", "group"])
      .openapi({
        description: "role = App Role Azure AD; group = object ID grup",
      }),
    claimValue: z
      .string()
      .min(1)
      .max(200)
      .openapi({ example: "MW.Station.LBB" }),
    role: z.enum(["viewer", "operator", "admin"]),
    scopes: z
      .array(z.string().regex(SCOPE_RE, "format scope: sumber:stasiun"))
      .min(1)
      .openapi({ example: ["*:LBB"] }),
    description: z.string().max(300).nullable().optional(),
    active: z.boolean().default(true),
  })
  .openapi("SsoMappingInput");

const ssoMappingDeleteQuery = z.object({
  claimType: z.enum(["role", "group"]),
  claimValue: z.string().min(1),
});

// ---------- response ----------
const ts = (description) => z.string().datetime().openapi({ description });
const sourceEnum = z.enum(SOURCES);

const Telemetry = z
  .object({
    kind: z.literal("telemetry"),
    source: sourceEnum,
    assetId: z.string(),
    station: z.string(),
    metric: z.string(),
    valueNum: z
      .number()
      .nullable()
      .openapi({ description: "Nilai numerik (boolean: 1/0)" }),
    valueText: z
      .string()
      .nullable()
      .openapi({
        description: "Nilai teks (status), atau 'true'/'false' untuk boolean",
      }),
    unit: z.string().nullable(),
    quality: z.enum(["good", "uncertain", "bad"]),
    sourceTs: ts("Waktu dari sistem sumber (UTC)"),
    receivedTs: ts("Waktu diterima middleware (UTC)"),
  })
  .openapi("Telemetry");

const TelemetryHourly = z
  .object({
    source: sourceEnum,
    station: z.string(),
    assetId: z.string(),
    metric: z.string(),
    unit: z.string().nullable(),
    hour: ts("Awal jam (UTC)"),
    samples: z.number().int(),
    avg: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    lastNum: z.number().nullable(),
    lastText: z.string().nullable(),
    lastTs: ts("Waktu sampel terakhir dalam jam tsb"),
  })
  .openapi("TelemetryHourly");

const Event = z
  .object({
    kind: z.literal("event"),
    source: sourceEnum,
    assetId: z.string(),
    station: z.string(),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    code: z.string().nullable(),
    message: z.string(),
    state: z.enum(["active", "cleared", "info"]),
    alarmKey: z
      .string()
      .nullable()
      .openapi({
        description:
          "Sama untuk alarm & clear-nya; null untuk event sekali kejadian",
      }),
    sourceTs: ts("Waktu dari sistem sumber (UTC)"),
    receivedTs: ts("Waktu diterima middleware (UTC)"),
  })
  .openapi("Event");

const TrainInfo = z
  .object({
    kind: z.literal("train_info"),
    source: z.literal("pids"),
    station: z.string(),
    platform: z.string().nullable(),
    trainNo: z.string().nullable(),
    refId: z
      .string()
      .nullable()
      .openapi({ description: "ID perjalanan atau ID gangguan" }),
    status: z
      .string()
      .nullable()
      .openapi({
        description:
          "ON_TIME | DELAYED | ARRIVED | DEPARTED | DISRUPTION_ACTIVE | DISRUPTION_CLEARED",
      }),
    direction: z.string().nullable().openapi({ description: "Tujuan / arah" }),
    type: z.enum(TRAIN_TYPES),
    scheduledTs: ts("Jadwal (UTC)").nullable(),
    estimatedTs: ts("Perkiraan (UTC)").nullable(),
    delaySec: z.number().int().nullable(),
    message: z.string().nullable(),
    sourceTs: ts("Waktu pesan dari PIDC (UTC)"),
    receivedTs: ts("Waktu diterima middleware (UTC)"),
  })
  .openapi("TrainInfo");

const BoardStation = z
  .object({
    station: z.string(),
    platforms: z
      .record(z.array(TrainInfo))
      .openapi({
        description:
          "Kunci = nomor peron; isi = kereta berikutnya urut perkiraan tiba",
      }),
    disruptions: z
      .array(TrainInfo)
      .openapi({ description: "Gangguan yang masih aktif di stasiun ini" }),
  })
  .openapi("BoardStation");

const Me = z
  .object({
    name: z
      .string()
      .openapi({ description: "Nama klien API key, atau UPN pengguna SSO" }),
    displayName: z.string().nullable(),
    authType: z.enum(["api_key", "sso"]),
    role: z.enum(["viewer", "operator", "admin"]),
    scopes: z.array(z.string()).openapi({ example: ["scada:*", "pids:LBB"] }),
    expiresAt: ts("Token SSO kedaluwarsa").nullable(),
  })
  .openapi("Me");

const ConnectorStatus = z
  .object({
    id: z.string(),
    source: sourceEnum,
    type: z.string(),
    state: z.enum([
      "idle",
      "connecting",
      "connected",
      "disconnected",
      "error",
      "stopped",
    ]),
    lastError: z.string().nullable(),
    lastRecordTs: ts("Data terakhir").nullable(),
    reconnectAttempts: z.number().int(),
  })
  .openapi("ConnectorStatus");

const TagMapping = z
  .object({
    id: z.number().int(),
    source: sourceEnum,
    sourceKey: z.string(),
    assetId: z.string(),
    station: z.string(),
    metric: z.string(),
    unit: z.string().nullable(),
    scale: z.number(),
    active: z.boolean(),
  })
  .openapi("TagMapping");

const SsoMapping = z
  .object({
    id: z.number().int(),
    claimType: z.enum(["role", "group"]),
    claimValue: z.string(),
    role: z.enum(["viewer", "operator", "admin"]),
    scopes: z.array(z.string()),
    description: z.string().nullable(),
    active: z.boolean(),
  })
  .openapi("SsoMapping");

const AuthConfig = z
  .object({
    sso: z
      .object({
        provider: z.literal("azure-ad"),
        tenantId: z.string(),
        clientId: z.string().nullable(),
        authority: z.string(),
        apiScope: z.string(),
      })
      .nullable(),
    apiKeyLogin: z.boolean(),
  })
  .openapi("AuthConfig");

const ErrorResponse = z
  .object({
    error: z.string().openapi({ example: "forbidden" }),
    detail: z.string().optional(),
    issues: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .openapi("Error");

/** Bungkus `{ data: ... }` seperti semua respons sukses API. */
const dataOf = (schema) => z.object({ data: schema });

module.exports = {
  z,
  queries: {
    telemetryQuery,
    telemetryHourlyQuery,
    latestQuery,
    eventsQuery,
    activeAlarmsQuery,
    trainInfoQuery,
    boardQuery,
    mappingsQuery,
    ssoMappingDeleteQuery,
  },
  bodies: { mappingBody, ssoMappingBody },
  responses: {
    Telemetry,
    TelemetryHourly,
    Event,
    TrainInfo,
    BoardStation,
    Me,
    ConnectorStatus,
    TagMapping,
    SsoMapping,
    AuthConfig,
    ErrorResponse,
  },
  dataOf,
  CATEGORIES,
};

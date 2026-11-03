"use strict";

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  SOURCES_CONFIG: z.string().default("config/sources.json"),
  DEDUP_TTL_MS: z.coerce.number().int().positive().default(600_000),
  DEDUP_MAX_ENTRIES: z.coerce.number().int().positive().default(200_000),
  /** Folder hasil build UI (web/dist). Kosong = Express tidak menyajikan UI. */
  WEB_DIST_DIR: z.string().optional(),

  // ---- Retensi data (hari). 0 = tidak dihapus otomatis. Lihat migrations/004_partitioning.sql ----
  // raw & telemetri minimal 8 hari: data boleh terlambat s.d. 7 hari (aturan validasi).
  RETENTION_RAW_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 8, "minimal 8 atau 0")
    .default(30),
  RETENTION_TELEMETRY_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 8, "minimal 8 atau 0")
    .default(90),
  RETENTION_TELEMETRY_HOURLY_DAYS: z.coerce.number().int().min(0).default(730),
  RETENTION_EVENTS_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 8, "minimal 8 atau 0")
    .default(730),
  RETENTION_TRAIN_INFO_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 8, "minimal 8 atau 0")
    .default(365),
  /** Audit dihapus otomatis hanya bila diisi (ikuti kebijakan keamanan informasi). */
  RETENTION_AUDIT_DAYS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 30, "minimal 30 atau 0")
    .default(0),
  /** Interval job maintenance (partisi, agregat, retensi). 0 = nonaktif (jalankan lewat npm run db:maintain). */
  MAINTENANCE_INTERVAL_MIN: z.coerce.number().int().min(0).default(60),

  // ---- Batas akses API (request per menit; 0 = tanpa batas) ----
  RATE_LIMIT_PER_CLIENT: z.coerce.number().int().min(0).default(600),
  RATE_LIMIT_PER_IP: z.coerce.number().int().min(0).default(1200),
  /** Express `trust proxy`: 'loopback' (default), jumlah hop, atau daftar IP reverse proxy. Menentukan req.ip. */
  TRUST_PROXY: z.string().default("loopback"),
  /** Sajikan dokumentasi interface di /docs dan /openapi.json. */
  API_DOCS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // ---- SSO Azure AD (Microsoft Entra ID). Kosongkan AZURE_AD_TENANT_ID untuk menonaktifkan SSO. ----
  AZURE_AD_TENANT_ID: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Client ID app registration API middleware (GUID). */
  AZURE_AD_API_CLIENT_ID: z.string().optional(),
  /** Application ID URI API, mis. api://mrt-middleware. Opsional; ikut diterima sebagai audience. */
  AZURE_AD_API_APP_ID_URI: z.string().optional(),
  /** Scope delegated yang wajib ada di token pengguna. */
  AZURE_AD_REQUIRED_SCOPE: z.string().default("access_as_user"),
  /** Client ID app registration SPA (UI). Dikirim ke UI lewat /api/v1/auth/config. */
  AZURE_AD_SPA_CLIENT_ID: z.string().optional(),
  /** Izinkan token aplikasi (client credentials) dengan App Role, sebagai pengganti API key. */
  AZURE_AD_ALLOW_APP_TOKENS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Terima juga token v1.0 (bila accessTokenAcceptedVersion di manifest API tidak diset ke 2). */
  AZURE_AD_ACCEPT_V1: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Hanya untuk pengujian lokal dengan mock (scripts/dev-aad-mock.js). Jangan diisi di produksi. */
  AZURE_AD_AUTHORITY_HOST: z
    .string()
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** Tampilkan form login API key di UI (untuk development / darurat). Di produksi sebaiknya false. */
  UI_ALLOW_API_KEY_LOGIN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const env = envSchema.parse(process.env);

if (env.AZURE_AD_TENANT_ID && !env.AZURE_AD_API_CLIENT_ID) {
  throw new Error(
    "AZURE_AD_API_CLIENT_ID wajib diisi bila AZURE_AD_TENANT_ID diisi",
  );
}
if (env.NODE_ENV === "production" && env.AZURE_AD_AUTHORITY_HOST) {
  throw new Error(
    "AZURE_AD_AUTHORITY_HOST hanya untuk pengujian dan tidak boleh dipakai di produksi",
  );
}

const connectorSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["scada", "nms", "pids"]),
  type: z.enum([
    "opcua",
    "http-poll",
    "webhook",
    "syslog",
    "snmp-trap",
    "websocket-client",
  ]),
  parser: z.string().min(1),
  enabled: z.boolean().default(true),
  options: z.record(z.unknown()).default({}),
});

const sourcesSchema = z.object({ connectors: z.array(connectorSchema) });

/**
 * @typedef {z.infer<typeof connectorSchema>} ConnectorConfig
 */

/** @returns {ConnectorConfig[]} */
function loadSourcesConfig(file = env.SOURCES_CONFIG) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    throw new Error(
      `Sources config not found: ${full} (salin dari config/sources.example.json)`,
    );
  }
  const parsed = sourcesSchema.parse(JSON.parse(fs.readFileSync(full, "utf8")));
  const ids = new Set();
  for (const c of parsed.connectors) {
    if (ids.has(c.id)) throw new Error(`Duplicate connector id: ${c.id}`);
    ids.add(c.id);
  }
  return parsed.connectors;
}

/** Ambil secret dari environment berdasarkan nama variabel di config (tidak pernah disimpan di file). */
function secretFromEnv(envName) {
  if (typeof envName !== "string" || !envName) return undefined;
  const v = process.env[envName];
  return v && v.length > 0 ? v : undefined;
}

module.exports = { env, loadSourcesConfig, secretFromEnv };

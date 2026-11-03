"use strict";

const {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} = require("@asteasolutions/zod-to-openapi");
const { z, queries: Q, bodies: B, responses: R, dataOf } = require("./schemas");
const pkg = require("../../package.json");

/**
 * Spesifikasi OpenAPI 3 dibangkitkan dari skema zod yang sama dengan validasi di routes.js.
 * Disajikan di GET /openapi.json dan dirender Swagger UI di /docs.
 */
function buildOpenApiDocument() {
  const reg = new OpenAPIRegistry();
  const apiKey = reg.registerComponent("securitySchemes", "ApiKey", {
    type: "apiKey",
    in: "header",
    name: "X-API-Key",
    description:
      "API key aplikasi (dibuat admin dengan `npm run client:create`).",
  });
  const bearer = reg.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Access token Azure AD (Microsoft Entra ID) untuk pengguna SSO, atau API key sebagai bearer.",
  });
  const security = [{ [apiKey.name]: [] }, { [bearer.name]: [] }];

  const errors = {
    400: {
      description: "Parameter tidak valid",
      content: { "application/json": { schema: R.ErrorResponse } },
    },
    401: {
      description: "Kredensial tidak ada, salah, atau kedaluwarsa",
      content: { "application/json": { schema: R.ErrorResponse } },
    },
    403: {
      description:
        "Kredensial valid tetapi role/scope tidak mencakup permintaan ini",
      content: { "application/json": { schema: R.ErrorResponse } },
    },
    429: {
      description: "Melewati rate limit; lihat header Retry-After",
      content: { "application/json": { schema: R.ErrorResponse } },
    },
  };
  const ok = (schema, description) => ({
    200: {
      description,
      content: { "application/json": { schema: dataOf(schema) } },
    },
    ...errors,
  });

  /** get /train-info/board → getTrainInfoBoard */
  const opId = (method, p) =>
    method +
    p
      .split(/[/-]/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");

  const path = (
    method,
    p,
    { summary, description, tags, query, body, response, role = "viewer" },
  ) =>
    reg.registerPath({
      method,
      path: `/api/v1${p}`,
      operationId: opId(method, p),
      summary,
      description:
        `${description ?? ""}\n\nRole minimum: **${role}**. Hasil otomatis difilter scope klien.`.trim(),
      tags,
      security,
      request: {
        ...(query ? { query } : {}),
        ...(body
          ? { body: { content: { "application/json": { schema: body } } } }
          : {}),
      },
      responses: response,
    });

  path("get", "/me", {
    summary: "Identitas, role, dan scope klien",
    tags: ["Akun"],
    response: ok(R.Me, "Identitas klien"),
  });

  path("get", "/telemetry", {
    summary: "Riwayat telemetri (nilai terukur & status)",
    description:
      "Urut terbaru dulu. Data detail disimpan sesuai RETENTION_TELEMETRY_DAYS (default 90 hari).",
    tags: ["Telemetri"],
    query: Q.telemetryQuery,
    response: ok(z.array(R.Telemetry), "Daftar telemetri"),
  });
  path("get", "/telemetry/latest", {
    summary: "Nilai terakhir per aset & metric (24 jam terakhir)",
    tags: ["Telemetri"],
    query: Q.latestQuery,
    response: ok(z.array(R.Telemetry), "Nilai terakhir"),
  });
  path("get", "/telemetry/hourly", {
    summary: "Agregat telemetri per jam (avg/min/max/terakhir)",
    description:
      "Untuk tren jangka panjang; disimpan lebih lama dari data detail (RETENTION_TELEMETRY_HOURLY_DAYS). Jam berjalan belum termasuk.",
    tags: ["Telemetri"],
    query: Q.telemetryHourlyQuery,
    response: ok(z.array(R.TelemetryHourly), "Agregat per jam"),
  });

  path("get", "/events", {
    summary: "Riwayat event, alarm, dan log",
    tags: ["Event & alarm"],
    query: Q.eventsQuery,
    response: ok(z.array(R.Event), "Daftar event"),
  });
  path("get", "/events/active", {
    summary: "Alarm yang masih aktif",
    description:
      "Event terakhir per `alarmKey` (7 hari terakhir) yang state-nya `active` — alarm yang sudah di-clear tidak ikut.",
    tags: ["Event & alarm"],
    query: Q.activeAlarmsQuery,
    response: ok(z.array(R.Event), "Alarm aktif"),
  });

  path("get", "/train-info", {
    summary: "Riwayat pesan PIDS",
    tags: ["Info kereta"],
    query: Q.trainInfoQuery,
    response: ok(z.array(R.TrainInfo), "Pesan PIDS"),
  });
  path("get", "/train-info/board", {
    summary: "Papan kedatangan terkini per stasiun & peron",
    description:
      "Kereta berikutnya (belum berangkat) per peron dan gangguan yang masih aktif.",
    tags: ["Info kereta"],
    query: Q.boardQuery,
    response: ok(z.array(R.BoardStation), "Papan per stasiun"),
  });

  path("get", "/connectors", {
    summary: "Status konektor sumber",
    tags: ["Operasional"],
    role: "operator",
    response: ok(z.array(R.ConnectorStatus), "Status konektor"),
  });

  path("get", "/mappings", {
    summary: "Daftar tag mapping",
    tags: ["Admin"],
    role: "admin",
    query: Q.mappingsQuery,
    response: ok(z.array(R.TagMapping), "Tag mapping"),
  });
  path("put", "/mappings", {
    summary: "Tambah/ubah tag mapping",
    description:
      "Konfigurasi internal middleware (bukan sistem sumber). Berlaku segera.",
    tags: ["Admin"],
    role: "admin",
    body: B.mappingBody,
    response: ok(R.TagMapping, "Mapping tersimpan"),
  });
  path("get", "/sso-mappings", {
    summary: "Daftar mapping App Role / grup Azure AD → role + scope",
    tags: ["Admin"],
    role: "admin",
    response: ok(z.array(R.SsoMapping), "Mapping SSO"),
  });
  path("put", "/sso-mappings", {
    summary: "Tambah/ubah mapping SSO",
    description: "Berlaku dalam ±60 detik.",
    tags: ["Admin"],
    role: "admin",
    body: B.ssoMappingBody,
    response: ok(R.SsoMapping, "Mapping tersimpan"),
  });
  path("delete", "/sso-mappings", {
    summary: "Hapus mapping SSO",
    tags: ["Admin"],
    role: "admin",
    query: Q.ssoMappingDeleteQuery,
    response: ok(z.object({ removed: z.boolean() }), "Hasil penghapusan"),
  });

  // ---- endpoint publik ----
  reg.registerPath({
    method: "get",
    path: "/api/v1/auth/config",
    operationId: "getAuthConfig",
    security: [],
    summary: "Konfigurasi login untuk UI (publik)",
    tags: ["Akun"],
    responses: {
      200: {
        description: "Konfigurasi login",
        content: { "application/json": { schema: dataOf(R.AuthConfig) } },
      },
    },
  });
  reg.registerPath({
    method: "get",
    path: "/ready",
    operationId: "getReady",
    security: [],
    summary:
      "Kesiapan: database & status konektor (publik, batasi di jaringan)",
    tags: ["Operasional"],
    responses: {
      200: { description: "Siap / degraded" },
      503: { description: "Database tidak tersedia" },
    },
  });
  reg.registerPath({
    method: "get",
    path: "/health",
    operationId: "getHealth",
    security: [],
    summary: "Liveness (publik)",
    tags: ["Operasional"],
    responses: { 200: { description: "OK" } },
  });
  reg.registerPath({
    method: "get",
    path: "/metrics",
    operationId: "getMetrics",
    security: [],
    summary: "Metric Prometheus (publik, batasi di jaringan)",
    tags: ["Operasional"],
    responses: { 200: { description: "Format teks Prometheus" } },
  });

  return new OpenApiGeneratorV3(reg.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "MRT Middleware Integration API",
      version: pkg.version,
      description: [
        "API read-only untuk data Facility SCADA, DTS/NMS, dan PIDS yang sudah dinormalisasi middleware.",
        "",
        "* **Autentikasi:** `X-API-Key` (aplikasi) atau `Authorization: Bearer` (token Azure AD pengguna SSO).",
        "* **Scope:** format `sumber:stasiun` (mis. `scada:*`, `*:LBB`). Data di luar scope tidak pernah dikembalikan;",
        "  meminta `source`/`station` di luar scope secara eksplisit → 403.",
        "* **Waktu:** semua timestamp UTC (ISO 8601). Tampilkan dalam WIB di sisi klien.",
        "* **Rate limit:** per klien; melewati batas → 429 + `Retry-After`.",
        "* **Data realtime:** WebSocket `/ws` — lihat spesifikasi AsyncAPI di `/docs/asyncapi.yaml`.",
        "* **Versi:** perubahan yang tidak kompatibel dirilis di `/api/v2`; `/api/v1` dipertahankan selama masa transisi.",
      ].join("\n"),
    },
    servers: [{ url: "/", description: "Server middleware ini" }],
    tags: [
      {
        name: "Telemetri",
        description: "Nilai terukur & status dari SCADA dan NMS",
      },
      {
        name: "Event & alarm",
        description:
          "Alarm (raise/clear), event perangkat, perubahan status, log",
      },
      {
        name: "Info kereta",
        description:
          "Kedatangan, keberangkatan, keterlambatan, gangguan dari PIDS",
      },
      { name: "Akun", description: "Identitas & konfigurasi login" },
      {
        name: "Operasional",
        description: "Status konektor, kesehatan, metric",
      },
      { name: "Admin", description: "Konfigurasi internal middleware" },
    ],
  });
}

module.exports = { buildOpenApiDocument };

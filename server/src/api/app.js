"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const { ZodError } = require("zod");
const { auditMiddleware } = require("./audit");
const { apiRouter } = require("./routes");
const { rateLimit } = require("./rate-limit");
const { buildOpenApiDocument } = require("./openapi");
const { registry } = require("../monitoring/metrics");
const { logger } = require("../logger");
const { env } = require("../config");

/**
 * @param {{
 *   repo: import('../storage/repository').Repository,
 *   connectors: import('../core/types').SourceConnector[],
 *   mapper: import('../pipeline/mapper').Mapper,
 *   auth: import('./auth').Authenticator
 * }} deps
 */
function createApp(deps) {
  const app = express();
  app.disable("x-powered-by");
  // req.ip (audit & rate limit per IP) bergantung pada ini bila middleware di belakang reverse proxy
  app.set(
    "trust proxy",
    /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY,
  );
  // MSAL (login Azure AD) memanggil endpoint token lewat fetch dan memperbarui token lewat iframe tersembunyi
  const authorityOrigin = new URL(
    env.AZURE_AD_AUTHORITY_HOST || "https://login.microsoftonline.com",
  ).origin;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // UI memakai WebSocket ke host yang sama
          "connect-src": ["'self'", "ws:", "wss:", authorityOrigin],
          "frame-src": ["'self'", authorityOrigin],
          // Middleware bisa diakses via HTTP di jaringan internal; jangan paksa upgrade ke HTTPS
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  // ---- Health & monitoring (tanpa auth; batasi di level jaringan/reverse proxy) ----
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/ready", async (_req, res) => {
    const connectors = deps.connectors.map((c) => c.status());
    let db = false;
    try {
      db = await deps.repo.ping();
    } catch {
      db = false;
    }
    const allConnected = connectors.every((c) => c.state === "connected");
    let status = "not_ready";
    if (db) status = allConnected ? "ready" : "degraded";
    res.status(db ? 200 : 503).json({
      status,
      database: db ? "up" : "down",
      connectors: connectors.map((c) => ({
        id: c.id,
        source: c.source,
        state: c.state,
      })),
    });
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  // ---- Konfigurasi login untuk UI (publik; tenant & client ID bukan rahasia) ----
  app.get("/api/v1/auth/config", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      data: {
        sso: deps.auth.ssoEnabled
          ? {
              provider: "azure-ad",
              tenantId: env.AZURE_AD_TENANT_ID,
              clientId: env.AZURE_AD_SPA_CLIENT_ID ?? null,
              authority: `${(env.AZURE_AD_AUTHORITY_HOST || "https://login.microsoftonline.com").replace(/\/$/, "")}/${env.AZURE_AD_TENANT_ID}`,
              apiScope: `${env.AZURE_AD_API_APP_ID_URI || `api://${env.AZURE_AD_API_CLIENT_ID}`}/${env.AZURE_AD_REQUIRED_SCOPE}`,
            }
          : null,
        apiKeyLogin: env.UI_ALLOW_API_KEY_LOGIN,
      },
    });
  });

  // ---- Dokumentasi interface: OpenAPI (REST) + AsyncAPI (WebSocket) ----
  if (env.API_DOCS_ENABLED) mountDocs(app);

  // ---- API konsumen: rate limit IP → audit (juga mencatat 401/403/429) → auth → rate limit klien → route ----
  app.use(
    "/api/v1",
    rateLimit({
      name: "per IP",
      limit: env.RATE_LIMIT_PER_IP,
      keyFn: (req) => `ip:${req.ip}`,
    }),
    auditMiddleware(deps.repo),
    deps.auth.middleware(),
    rateLimit({
      name: "per klien",
      limit: env.RATE_LIMIT_PER_CLIENT,
      keyFn: (req) =>
        req.auth
          ? `client:${req.auth.authType}:${req.auth.clientId ?? req.auth.clientName}`
          : null,
    }),
    apiRouter(deps),
  );

  // ---- UI dashboard (hasil build React) — opsional ----
  if (env.WEB_DIST_DIR) {
    const dist = path.resolve(env.WEB_DIST_DIR);
    if (fs.existsSync(path.join(dist, "index.html"))) {
      app.use(express.static(dist, { index: false, maxAge: "1h" }));
      app.get(/^\/(?!api\/|ws$|docs|openapi\.json$).*/, (_req, res) =>
        res.sendFile(path.join(dist, "index.html")),
      );
      logger.info({ dist }, "serving web UI");
    } else {
      logger.warn(
        { dist },
        "WEB_DIST_DIR set but index.html not found (jalankan npm run build di web/)",
      );
    }
  }

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res
        .status(400)
        .json({
          error: "bad_request",
          issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
        });
    }
    if (err.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: "bad_request", detail: "body bukan JSON yang valid" });
    if (err.status && err.status < 500)
      return res.status(err.status).json({ error: err.message });
    logger.error({ err: String(err) }, "unhandled API error");
    return res.status(500).json({ error: "internal_error" });
  });

  return app;
}

/**
 * /openapi.json  spesifikasi REST (dibangkitkan dari skema zod)
 * /docs          Swagger UI (aset lokal dari swagger-ui-dist; tanpa CDN, aman di jaringan internal)
 * /docs/asyncapi.yaml  spesifikasi WebSocket /ws
 */
function mountDocs(app) {
  const swaggerDist = require("swagger-ui-dist").getAbsoluteFSPath();
  let spec = null;
  app.get("/openapi.json", (_req, res) => {
    spec ??= buildOpenApiDocument();
    res.json(spec);
  });
  app.use(
    "/docs/assets",
    express.static(swaggerDist, { index: false, maxAge: "1d" }),
  );
  app.get("/docs/init.js", (_req, res) => {
    // file terpisah (bukan inline) agar lolos CSP script-src 'self'
    res
      .type("application/javascript")
      .send(
        "window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: false });",
      );
  });
  const asyncapi = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "docs",
    "asyncapi.yaml",
  );
  app.get("/docs/asyncapi.yaml", (_req, res) =>
    fs.existsSync(asyncapi)
      ? res.type("application/yaml").sendFile(asyncapi)
      : res.status(404).json({ error: "not_found" }),
  );
  app.get(["/docs", "/docs/"], (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MRT Middleware API</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/init.js"></script></body></html>`);
  });
  logger.info(
    "API docs at /docs (OpenAPI /openapi.json, AsyncAPI /docs/asyncapi.yaml)",
  );
}

module.exports = { createApp };

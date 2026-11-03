"use strict";

const http = require("node:http");
const { env, loadSourcesConfig } = require("./config");
const { logger } = require("./logger");
const { pool } = require("./storage/pool");
const { Repository } = require("./storage/repository");
const { createConnector } = require("./connectors/registry");
const { getParser } = require("./parsers");
const { Mapper } = require("./pipeline/mapper");
const { DedupCache } = require("./pipeline/dedup");
const { Pipeline } = require("./pipeline/pipeline");
const { DistributionHub } = require("./distribution/websocket");
const { Authenticator } = require("./api/auth");
const { AzureAdVerifier } = require("./auth/azure-ad");
const { createApp } = require("./api/app");
const { metrics, bindRuntime } = require("./monitoring/metrics");
const { startMaintenanceScheduler } = require("./maintenance/maintenance");

async function main() {
  const repo = new Repository(pool);
  await repo.ping();
  logger.info("database connected");

  const mapper = new Mapper(repo);
  await mapper.start();

  const azure = env.AZURE_AD_TENANT_ID
    ? new AzureAdVerifier({
        tenantId: env.AZURE_AD_TENANT_ID,
        audiences: [
          env.AZURE_AD_API_CLIENT_ID,
          env.AZURE_AD_API_APP_ID_URI,
        ].filter(Boolean),
        requiredScope: env.AZURE_AD_REQUIRED_SCOPE,
        allowAppTokens: env.AZURE_AD_ALLOW_APP_TOKENS,
        acceptV1: env.AZURE_AD_ACCEPT_V1,
        authorityHost: env.AZURE_AD_AUTHORITY_HOST,
      })
    : null;
  logger.info(
    {
      sso: azure ? "azure-ad" : "disabled",
      apiKeyLoginInUi: env.UI_ALLOW_API_KEY_LOGIN,
    },
    "auth configured",
  );
  const auth = new Authenticator(repo, { azure });
  const hub = new DistributionHub(auth, repo);
  const pipeline = new Pipeline(
    repo,
    mapper,
    hub,
    new DedupCache(env.DEDUP_TTL_MS, env.DEDUP_MAX_ENTRIES),
  );

  // ---- Konektor ----
  const configs = loadSourcesConfig().filter((c) => c.enabled);
  const connectors = configs.map((cfg) => {
    const parser = getParser(cfg.parser);
    const conn = createConnector(cfg);
    conn.on("record", (raw) => pipeline.submit(raw, parser));
    conn.on("status", (s) => {
      metrics.connectorUp.set(
        { source: s.source, connector: s.id },
        s.state === "connected" ? 1 : 0,
      );
      repo
        .upsertConnectorStatus(s)
        .catch((err) =>
          logger.error({ err: String(err) }, "status write failed"),
        );
    });
    return conn;
  });
  bindRuntime({ connectors, pipeline, repo });

  // ---- HTTP + WebSocket ----
  const app = createApp({ repo, connectors, mapper, auth });
  const server = http.createServer(app);
  hub.attach(server);
  await new Promise((resolve) => {
    server.listen(env.PORT, resolve);
  });
  logger.info({ port: env.PORT }, "API & WebSocket listening");

  // Satu konektor gagal tidak menghentikan yang lain
  await Promise.all(connectors.map((c) => c.start()));
  logger.info(
    { connectors: connectors.map((c) => c.id) },
    "connectors started",
  );

  // ---- Maintenance database: partisi, agregat per jam, retensi ----
  const stopMaintenance = startMaintenanceScheduler(pool);

  // ---- Graceful shutdown ----
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await Promise.allSettled(connectors.map((c) => c.stop()));
    stopMaintenance();
    mapper.stop();
    hub.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, "failed to start");
  process.exit(1);
});

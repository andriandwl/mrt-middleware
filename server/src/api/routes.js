"use strict";

const { Router } = require("express");
const { requireRole, scopeAllows, formatScopes } = require("./auth");
const { queries: Q, bodies: B } = require("./schemas");

/** Bungkus handler async agar error diteruskan ke error handler Express. */
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/** Bila konsumen meminta source/station spesifik di luar scope-nya → 403 (bukan hasil kosong diam-diam). */
function assertScope(req, src, st) {
  if (!src && !st) return;
  const ok = req.auth.scopes.some(
    (s) =>
      (!src || s.source === "*" || s.source === src) &&
      (!st || s.station === "*" || s.station === st),
  );
  if (!ok) throw Object.assign(new Error("scope not allowed"), { status: 403 });
}

/**
 * Semua skema request ada di ./schemas.js (dipakai juga untuk OpenAPI /docs).
 * Bila menambah endpoint: tambahkan skema di schemas.js dan path-nya di openapi.js.
 *
 * @param {{
 *   repo: import('../storage/repository').Repository,
 *   connectors: import('../core/types').SourceConnector[],
 *   mapper: import('../pipeline/mapper').Mapper
 * }} deps
 */
function apiRouter({ repo, connectors, mapper }) {
  const r = Router();

  // ---- Identitas klien ----
  r.get("/me", (req, res) => {
    res.json({
      data: {
        name: req.auth.clientName,
        displayName: req.auth.displayName ?? null,
        authType: req.auth.authType,
        role: req.auth.role,
        scopes: formatScopes(req.auth.scopes).split(","),
        expiresAt: req.auth.expiresAt ?? null,
      },
    });
  });

  // ---- Data (viewer+) ----
  r.get(
    "/telemetry",
    wrap(async (req, res) => {
      const q = Q.telemetryQuery.parse(req.query);
      assertScope(req, q.source, q.station);
      res.json({ data: await repo.queryTelemetry(req.auth.scopes, q) });
    }),
  );

  r.get(
    "/telemetry/hourly",
    wrap(async (req, res) => {
      const q = Q.telemetryHourlyQuery.parse(req.query);
      assertScope(req, q.source, q.station);
      res.json({ data: await repo.queryTelemetryHourly(req.auth.scopes, q) });
    }),
  );

  r.get(
    "/telemetry/latest",
    wrap(async (req, res) => {
      const q = Q.latestQuery.parse(req.query);
      assertScope(req, q.source, q.station);
      res.json({ data: await repo.latestTelemetry(req.auth.scopes, q) });
    }),
  );

  r.get(
    "/events",
    wrap(async (req, res) => {
      const q = Q.eventsQuery.parse(req.query);
      assertScope(req, q.source, q.station);
      res.json({
        data: await repo.queryEvents(req.auth.scopes, {
          ...q,
          categories: q.category,
        }),
      });
    }),
  );

  // Alarm yang masih aktif (raise tanpa clear), berdasarkan alarm_key
  r.get(
    "/events/active",
    wrap(async (req, res) => {
      const q = Q.activeAlarmsQuery.parse(req.query);
      assertScope(req, q.source, q.station);
      res.json({ data: await repo.activeAlarms(req.auth.scopes, q) });
    }),
  );

  r.get(
    "/train-info",
    wrap(async (req, res) => {
      const q = Q.trainInfoQuery.parse(req.query);
      assertScope(req, "pids", q.station);
      res.json({ data: await repo.queryTrainInfo(req.auth.scopes, q) });
    }),
  );

  // Papan kedatangan terkini per stasiun & peron + gangguan aktif
  r.get(
    "/train-info/board",
    wrap(async (req, res) => {
      const q = Q.boardQuery.parse(req.query);
      assertScope(req, "pids", q.station);
      res.json({ data: await repo.trainBoard(req.auth.scopes, q) });
    }),
  );

  // ---- Status konektor (operator+) ----
  r.get("/connectors", requireRole("operator"), (req, res) => {
    const visible = connectors
      .map((c) => c.status())
      .filter(
        (s) =>
          req.auth.role === "admin" ||
          scopeAllows(req.auth.scopes, s.source, "*"),
      );
    res.json({ data: visible });
  });

  // ---- Tag mapping (admin) — konfigurasi internal middleware, BUKAN sistem sumber ----
  r.get(
    "/mappings",
    requireRole("admin"),
    wrap(async (req, res) => {
      const q = Q.mappingsQuery.parse(req.query);
      res.json({ data: await repo.listMappings(q.source) });
    }),
  );

  r.put(
    "/mappings",
    requireRole("admin"),
    wrap(async (req, res) => {
      const body = B.mappingBody.parse(req.body);
      const saved = await repo.upsertMapping(body);
      await mapper.refresh();
      res.json({ data: saved });
    }),
  );

  // ---- Mapping SSO (admin): App Role / grup Azure AD → role + scope middleware ----
  r.get(
    "/sso-mappings",
    requireRole("admin"),
    wrap(async (_req, res) => {
      res.json({ data: await repo.listSsoMappings() });
    }),
  );

  r.put(
    "/sso-mappings",
    requireRole("admin"),
    wrap(async (req, res) => {
      const body = B.ssoMappingBody.parse(req.body);
      res.json({ data: await repo.upsertSsoMapping(body) });
    }),
  );

  r.delete(
    "/sso-mappings",
    requireRole("admin"),
    wrap(async (req, res) => {
      const q = Q.ssoMappingDeleteQuery.parse(req.query);
      const removed = await repo.deleteSsoMapping(q.claimType, q.claimValue);
      res.status(removed ? 200 : 404).json({ data: { removed } });
    }),
  );

  return r;
}

module.exports = { apiRouter };

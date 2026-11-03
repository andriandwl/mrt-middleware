"use strict";

const { createHash } = require("node:crypto");
const { AzureAdVerifier } = require("../auth/azure-ad");
const { logger } = require("../logger");
const { metrics } = require("../monitoring/metrics");

/**
 * @typedef {'viewer'|'operator'|'admin'} Role
 * @typedef {{ source: string, station: string }} Scope   source: scada|nms|pids|*, station: kode|*
 * @typedef {{
 *   clientId: string|null,       UUID klien API key, atau object ID (oid) Azure AD
 *   clientName: string,          nama klien API key, atau UPN/email pengguna
 *   displayName: string|null,    nama tampilan pengguna (SSO)
 *   role: Role,
 *   scopes: Scope[],
 *   authType: 'api_key'|'sso',
 *   expiresAt: Date|null         token SSO kedaluwarsa (untuk WebSocket)
 * }} AuthContext
 */

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

const hashApiKey = (key) =>
  createHash("sha256").update(key, "utf8").digest("hex");

/**
 * "scada:*" → {source:'scada', station:'*'}; "pids:LBB" → {source:'pids', station:'LBB'}
 * @param {string[]} raw @returns {Scope[]}
 */
function parseScopes(raw) {
  return raw
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [source = "*", station = "*"] = s.split(":");
      return { source: source || "*", station: (station || "*").toUpperCase() };
    });
}

/** @param {Scope[]} scopes */
function scopeAllows(scopes, source, station) {
  const st = String(station).toUpperCase();
  return scopes.some(
    (s) =>
      (s.source === "*" || s.source === source) &&
      (s.station === "*" || station === "*" || s.station === st),
  );
}

/** @param {Scope[]} scopes */
const formatScopes = (scopes) =>
  scopes.map((s) => `${s.source}:${s.station}`).join(",");

/** Gabungkan scope tanpa duplikat. */
function mergeScopes(lists) {
  const seen = new Map();
  lists.flat().forEach((s) => seen.set(`${s.source}:${s.station}`, s));
  return [...seen.values()];
}

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Autentikasi semua konsumen:
 *  - API key (aplikasi / service, header X-API-Key atau Bearer mrtmw_...)
 *  - Access token Azure AD (pengguna lewat SSO; opsional token aplikasi), header Bearer eyJ...
 * Role & scope SSO berasal dari tabel sso_role_mappings (App Role / grup → role + scope).
 */
class Authenticator {
  /**
   * @param {import('../storage/repository').Repository} repo
   * @param {{ azure?: AzureAdVerifier|null, ttlMs?: number }} [opts]
   */
  constructor(repo, opts = {}) {
    this.repo = repo;
    this.azure = opts.azure ?? null;
    this.ttlMs = opts.ttlMs ?? 60_000;
    /** @type {Map<string, { ctx: AuthContext|null, exp: number }>} */
    this.keyCache = new Map();
    this.mappings = [];
    this.mappingsLoadedAt = 0;
  }

  get ssoEnabled() {
    return Boolean(this.azure);
  }

  /**
   * @param {string|undefined} credential  API key atau JWT
   * @returns {Promise<AuthContext>}
   * @throws {AuthError}
   */
  async authenticate(credential) {
    if (!credential) throw new AuthError(401, "kredensial tidak ada");
    if (AzureAdVerifier.looksLikeJwt(credential))
      return this.authenticateJwt(credential);
    return this.authenticateApiKey(credential);
  }

  async authenticateApiKey(apiKey) {
    if (apiKey.length < 20) throw new AuthError(401, "API key tidak valid");
    const hash = hashApiKey(apiKey);
    const hit = this.keyCache.get(hash);
    let ctx;
    if (hit && hit.exp > Date.now()) ctx = hit.ctx;
    else {
      const client = await this.repo.findClientByKeyHash(hash);
      ctx = client
        ? {
            clientId: client.id,
            clientName: client.name,
            displayName: null,
            role: client.role,
            scopes: parseScopes(client.scopes),
            authType: "api_key",
            expiresAt: null,
          }
        : null;
      this.keyCache.set(hash, { ctx, exp: Date.now() + this.ttlMs });
    }
    if (!ctx)
      throw new AuthError(
        401,
        "API key tidak valid, nonaktif, atau kedaluwarsa",
      );
    return ctx;
  }

  async authenticateJwt(token) {
    if (!this.azure)
      throw new AuthError(401, "SSO tidak diaktifkan di middleware ini");
    let verified;
    try {
      verified = await this.azure.verify(token);
    } catch (err) {
      throw new AuthError(401, err.reason ?? "token tidak valid");
    }
    const { claims, kind } = verified;

    const roles = Array.isArray(claims.roles) ? claims.roles : [];
    const groups = Array.isArray(claims.groups) ? claims.groups : [];
    if (claims._claim_names?.groups) {
      logger.warn(
        { oid: claims.oid },
        "groups overage claim: gunakan App Role, bukan grup, untuk pengguna dengan banyak grup",
      );
    }

    const mappings = await this.getMappings();
    const matched = mappings.filter(
      (m) =>
        (m.claimType === "role" && roles.includes(m.claimValue)) ||
        (m.claimType === "group" && groups.includes(m.claimValue)),
    );
    if (!matched.length) {
      throw new AuthError(
        403,
        "akun Anda belum diberi akses ke middleware (minta App Role ke admin)",
      );
    }
    const role = matched.reduce(
      (best, m) => (ROLE_RANK[m.role] > ROLE_RANK[best] ? m.role : best),
      "viewer",
    );
    const scopes = mergeScopes(matched.map((m) => parseScopes(m.scopes)));

    const name =
      kind === "user"
        ? (claims.preferred_username ??
          claims.upn ??
          claims.email ??
          claims.oid)
        : `app:${claims.azp ?? claims.appid ?? claims.oid}`;
    return {
      clientId: claims.oid ?? null,
      clientName: String(name),
      displayName: claims.name ?? null,
      role,
      scopes,
      authType: "sso",
      expiresAt: claims.exp ? new Date(claims.exp * 1000) : null,
    };
  }

  /** Mapping App Role/grup → role+scope, di-cache ttlMs. */
  async getMappings() {
    if (Date.now() - this.mappingsLoadedAt > this.ttlMs) {
      try {
        this.mappings = await this.repo.listSsoMappings({ activeOnly: true });
        this.mappingsLoadedAt = Date.now();
      } catch (err) {
        logger.error({ err: String(err) }, "failed to load sso mappings");
      }
    }
    return this.mappings;
  }

  /** Ambil kredensial dari header: X-API-Key atau Authorization: Bearer <API key|JWT>. */
  static credentialFromRequest(req) {
    const header = req.header("authorization");
    return (
      req.header("x-api-key") ??
      (header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined)
    );
  }

  /** Express middleware. 401 = kredensial salah/kedaluwarsa; 403 = valid tapi belum diberi akses. */
  middleware() {
    return async (req, res, next) => {
      try {
        req.auth = await this.authenticate(
          Authenticator.credentialFromRequest(req),
        );
        return next();
      } catch (err) {
        if (err instanceof AuthError) {
          res.locals.authError = err.message; // dicatat di audit
          metrics.authFailures.inc({ status: String(err.status) });
          if (err.status === 401) res.set("WWW-Authenticate", "Bearer");
          return res
            .status(err.status)
            .json({
              error: err.status === 401 ? "unauthorized" : "forbidden",
              detail: err.message,
            });
        }
        return next(err);
      }
    };
  }
}

/** @param {Role} min */
function requireRole(min) {
  return (req, res, next) => {
    if (!req.auth || ROLE_RANK[req.auth.role] < ROLE_RANK[min]) {
      return res.status(403).json({ error: "forbidden", requiredRole: min });
    }
    return next();
  };
}

module.exports = {
  Authenticator,
  AuthError,
  requireRole,
  hashApiKey,
  parseScopes,
  scopeAllows,
  formatScopes,
  ROLE_RANK,
};

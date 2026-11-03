"use strict";

const { formatScopes } = require("./auth");
const { logger } = require("../logger");

/**
 * Catat setiap request API konsumen ke audit_logs setelah response selesai,
 * termasuk request yang ditolak (401/403) — identitas kosong bila autentikasi gagal.
 * @param {import('../storage/repository').Repository} repo
 */
function auditMiddleware(repo) {
  return (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      repo
        .insertAudit({
          clientId: req.auth?.clientId,
          clientName: req.auth?.clientName,
          role: req.auth?.role,
          authType: req.auth?.authType ?? null,
          channel: "rest",
          method: req.method,
          path: req.originalUrl.split("?")[0],
          scopeUsed: req.auth ? formatScopes(req.auth.scopes) : null,
          statusCode: res.statusCode,
          ip: req.ip,
          detail: {
            query: req.query,
            durationMs: Date.now() - started,
            ...(res.locals.authError
              ? { authError: res.locals.authError }
              : {}),
          },
        })
        .catch((err) =>
          logger.error({ err: String(err) }, "audit write failed"),
        );
    });
    next();
  };
}

module.exports = { auditMiddleware };

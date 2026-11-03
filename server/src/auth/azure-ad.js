"use strict";

const { createRemoteJWKSet, jwtVerify, errors } = require("jose");

/**
 * Verifikasi access token Azure AD (Microsoft Entra ID) untuk API middleware.
 *
 * Yang diperiksa:
 *  - tanda tangan (RS256) terhadap kunci publik tenant dari endpoint JWKS (di-cache oleh jose)
 *  - issuer = tenant ini (token v2.0, dan v1.0 bila diizinkan), klaim `tid` = tenant ini
 *  - audience = API middleware (client ID dan/atau Application ID URI)
 *  - masa berlaku (exp/nbf) dengan toleransi clock skew
 *  - token delegated (pengguna): klaim `scp` harus memuat scope API yang disyaratkan
 *  - token aplikasi (client credentials, tanpa `scp`): hanya diterima bila allowAppTokens = true
 */
class AzureAdVerifier {
  /**
   * @param {{
   *   tenantId: string,
   *   audiences: string[],
   *   requiredScope: string,
   *   allowAppTokens: boolean,
   *   authorityHost?: string,
   *   acceptV1?: boolean,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    const host = (
      opts.authorityHost || "https://login.microsoftonline.com"
    ).replace(/\/$/, "");
    this.jwks = createRemoteJWKSet(
      new URL(`${host}/${opts.tenantId}/discovery/v2.0/keys`),
      {
        cooldownDuration: 30_000, // jeda minimum antar-refresh JWKS saat kid tidak dikenal
        cacheMaxAge: 6 * 3600_000,
      },
    );
    this.issuers = [`${host}/${opts.tenantId}/v2.0`];
    // token v1.0 (accessTokenAcceptedVersion = null/1) memakai issuer sts.windows.net
    if (opts.acceptV1)
      this.issuers.push(`https://sts.windows.net/${opts.tenantId}/`);
  }

  /** Sekilas: apakah string ini berbentuk JWT (bukan API key)? */
  static looksLikeJwt(token) {
    return (
      typeof token === "string" && /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token)
    );
  }

  /**
   * @param {string} token
   * @returns {Promise<{ claims: Record<string, any>, kind: 'user'|'app' }>}
   * @throws {Error} dengan `.reason` yang aman ditampilkan / dicatat
   */
  async verify(token) {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuers,
        audience: this.opts.audiences,
        algorithms: ["RS256"],
        clockTolerance: 120,
      }));
    } catch (err) {
      throw reasonError(describeJoseError(err));
    }

    if (payload.tid !== this.opts.tenantId)
      throw reasonError("tenant tidak cocok");

    const scp = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
    if (scp.length) {
      if (this.opts.requiredScope && !scp.includes(this.opts.requiredScope)) {
        throw reasonError(
          `scope ${this.opts.requiredScope} tidak ada di token`,
        );
      }
      return { claims: payload, kind: "user" };
    }
    if (!this.opts.allowAppTokens)
      throw reasonError("token aplikasi tidak diizinkan");
    return { claims: payload, kind: "app" };
  }
}

function reasonError(reason) {
  return Object.assign(new Error(reason), { reason });
}

function describeJoseError(err) {
  if (err instanceof errors.JWTExpired) return "token kedaluwarsa";
  if (err instanceof errors.JWTClaimValidationFailed)
    return `klaim ${err.claim} tidak valid`;
  if (err instanceof errors.JWSSignatureVerificationFailed)
    return "tanda tangan token tidak valid";
  if (err instanceof errors.JWKSNoMatchingKey)
    return "kunci penanda tangan tidak dikenal";
  if (err instanceof errors.JWKSTimeout || err?.code === "ERR_JWKS_TIMEOUT")
    return "JWKS Azure AD tidak dapat dihubungi";
  return "token tidak valid";
}

module.exports = { AzureAdVerifier };

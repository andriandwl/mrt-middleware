"use strict";

/**
 * MOCK Azure AD (Microsoft Entra ID) — HANYA UNTUK PENGEMBANGAN & PENGUJIAN LOKAL.
 * Meniru endpoint OIDC v2.0 secukupnya agar alur login UI (MSAL, Authorization Code + PKCE) dan validasi
 * token di middleware bisa diuji sebelum app registration di tenant MRT tersedia.
 *
 * Menjalankan:
 *   AZURE_AD_TENANT_ID=<uuid> AZURE_AD_API_CLIENT_ID=<uuid> AZURE_AD_SPA_CLIENT_ID=<uuid> \
 *   MOCK_TLS_CERT=cert.pem MOCK_TLS_KEY=key.pem npm run dev:aad-mock
 * lalu di server/.env:  AZURE_AD_AUTHORITY_HOST=https://localhost:8099  (+ NODE_EXTRA_CA_CERTS=cert.pem)
 *
 * MSAL mensyaratkan authority HTTPS, jadi untuk login lewat UI sediakan sertifikat (self-signed pun cukup).
 * Tanpa sertifikat, mock berjalan di HTTP — cukup untuk menguji API dengan token dari /dev/token.
 *
 * Endpoint (prefix /<tenant>):
 *   /v2.0/.well-known/openid-configuration   discovery
 *   /discovery/v2.0/keys                     JWKS
 *   /oauth2/v2.0/authorize                   halaman pilih pengguna uji → redirect dengan code
 *   /oauth2/v2.0/token                       authorization_code (PKCE S256) & refresh_token
 *   /oauth2/v2.0/logout                      redirect ke post_logout_redirect_uri
 *   GET /dev/token?user=occ                  access token langsung (untuk curl / uji API)
 *
 * Env: MOCK_PORT (8099), MOCK_TOKEN_TTL_S (3600), MOCK_TLS_CERT, MOCK_TLS_KEY.
 * Middleware menolak AZURE_AD_AUTHORITY_HOST bila NODE_ENV=production.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { generateKeyPair, exportJWK, SignJWT } = require("jose");

const TENANT = process.env.AZURE_AD_TENANT_ID;
const API_CLIENT_ID = process.env.AZURE_AD_API_CLIENT_ID;
const SPA_CLIENT_ID = process.env.AZURE_AD_SPA_CLIENT_ID;
const PORT = Number(process.env.MOCK_PORT || 8099);
const TTL = Number(process.env.MOCK_TOKEN_TTL_S || 3600);
const TLS = process.env.MOCK_TLS_CERT && process.env.MOCK_TLS_KEY;
if (!TENANT || !API_CLIENT_ID) {
  console.error(
    "Set AZURE_AD_TENANT_ID dan AZURE_AD_API_CLIENT_ID (sama dengan server/.env)",
  );
  process.exit(1);
}
const BASE = `${TLS ? "https" : "http"}://localhost:${PORT}`;
const ISSUER = `${BASE}/${TENANT}/v2.0`;

/** Pengguna uji. roles = App Role yang di-assign (lihat sso_role_mappings). */
const USERS = {
  occ: {
    oid: "11111111-1111-4111-8111-111111111111",
    name: "Operator OCC (uji)",
    upn: "occ.operator@mrt.test",
    roles: ["MW.OCC.Operator"],
  },
  lbb: {
    oid: "22222222-2222-4222-8222-222222222222",
    name: "Petugas Stasiun LBB (uji)",
    upn: "petugas.lbb@mrt.test",
    roles: ["MW.Station.LBB"],
  },
  admin: {
    oid: "33333333-3333-4333-8333-333333333333",
    name: "Admin Middleware (uji)",
    upn: "admin@mrt.test",
    roles: ["MW.Admin"],
  },
  none: {
    oid: "44444444-4444-4444-8444-444444444444",
    name: "Tanpa Akses (uji)",
    upn: "tanpa.akses@mrt.test",
    roles: [],
  },
};

const codes = new Map();
const refreshTokens = new Map();
let keys;
let jwk;

const b64url = (s) => Buffer.from(s).toString("base64url");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sign(claims, ttl) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, ver: "2.0", tid: TENANT })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + ttl)
    .sign(keys.privateKey);
}

async function issueTokens(userKey, clientId, scope, nonce) {
  const u = USERS[userKey];
  const access = await sign(
    {
      aud: API_CLIENT_ID,
      oid: u.oid,
      sub: u.oid,
      azp: clientId,
      scp: "access_as_user",
      roles: u.roles,
      name: u.name,
      preferred_username: u.upn,
    },
    TTL,
  );
  const id = await sign(
    {
      aud: clientId,
      oid: u.oid,
      sub: u.oid,
      name: u.name,
      preferred_username: u.upn,
      ...(nonce ? { nonce } : {}),
    },
    3600,
  );
  const refresh = randomBytes(24).toString("base64url");
  refreshTokens.set(refresh, { userKey, clientId, scope });
  return {
    token_type: "Bearer",
    scope,
    expires_in: TTL,
    ext_expires_in: TTL,
    access_token: access,
    refresh_token: refresh,
    id_token: id,
    client_info: b64url(JSON.stringify({ uid: u.oid, utid: TENANT })),
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const readBody = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });

async function handler(req, res) {
  const url = new URL(req.url, BASE);
  const p = url.pathname.replace(/\/+$/, "");
  const t = `/${TENANT}`;
  if (req.method === "OPTIONS")
    return send(res, 204, "", {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });

  if (
    p === `${t}/v2.0/.well-known/openid-configuration` ||
    p === `${t}/.well-known/openid-configuration`
  ) {
    return send(
      res,
      200,
      {
        issuer: ISSUER,
        authorization_endpoint: `${BASE}${t}/oauth2/v2.0/authorize`,
        token_endpoint: `${BASE}${t}/oauth2/v2.0/token`,
        end_session_endpoint: `${BASE}${t}/oauth2/v2.0/logout`,
        jwks_uri: `${BASE}${t}/discovery/v2.0/keys`,
        response_modes_supported: ["query", "fragment", "form_post"],
        response_types_supported: ["code"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
        subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      },
      { "Content-Type": "application/json" },
    );
  }

  if (p === `${t}/discovery/v2.0/keys`)
    return send(
      res,
      200,
      { keys: [jwk] },
      { "Content-Type": "application/json" },
    );

  if (p === `${t}/oauth2/v2.0/authorize`) {
    const q = url.searchParams;
    if (SPA_CLIENT_ID && q.get("client_id") !== SPA_CLIENT_ID)
      return send(res, 400, "client_id tidak dikenal");
    const links = Object.entries(USERS)
      .map(([k, u]) => {
        const next = new URL(`${BASE}${t}/oauth2/v2.0/authorize/complete`);
        q.forEach((v, key) => next.searchParams.set(key, v));
        next.searchParams.set("user", k);
        return `<li><a id="user-${k}" href="${esc(next)}">${esc(u.name)}</a> <small>${esc(u.upn)} · ${esc(u.roles.join(", ") || "tanpa App Role")}</small></li>`;
      })
      .join("");
    return send(
      res,
      200,
      `<!doctype html><html lang="id"><meta charset="utf-8"><title>Mock Azure AD</title><body style="font-family:sans-serif;max-width:560px;margin:48px auto">
       <h2>Mock Azure AD — pilih pengguna uji</h2><p>Hanya untuk pengembangan lokal. Bukan login Microsoft sungguhan.</p><ul>${links}</ul></body></html>`,
      { "Content-Type": "text/html; charset=utf-8" },
    );
  }

  if (p === `${t}/oauth2/v2.0/authorize/complete`) {
    const q = url.searchParams;
    const userKey = q.get("user");
    if (!USERS[userKey]) return send(res, 400, "pengguna tidak dikenal");
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      userKey,
      clientId: q.get("client_id"),
      redirectUri: q.get("redirect_uri"),
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce"),
      scope: q.get("scope"),
      exp: Date.now() + 120_000,
    });
    const params = new URLSearchParams({
      code,
      state: q.get("state") ?? "",
      client_info: b64url(
        JSON.stringify({ uid: USERS[userKey].oid, utid: TENANT }),
      ),
      session_state: randomUUID(),
    });
    const sep = q.get("response_mode") === "query" ? "?" : "#";
    return send(res, 302, "", {
      Location: `${q.get("redirect_uri")}${sep}${params}`,
    });
  }

  if (p === `${t}/oauth2/v2.0/token` && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    if (f.get("grant_type") === "authorization_code") {
      const c = codes.get(f.get("code"));
      codes.delete(f.get("code"));
      if (!c || c.exp < Date.now())
        return send(res, 400, {
          error: "invalid_grant",
          error_description: "code tidak valid",
        });
      if (
        c.redirectUri !== f.get("redirect_uri") ||
        c.clientId !== f.get("client_id")
      )
        return send(res, 400, { error: "invalid_grant" });
      const verifier = f.get("code_verifier") ?? "";
      if (
        createHash("sha256").update(verifier).digest("base64url") !==
        c.challenge
      ) {
        return send(res, 400, {
          error: "invalid_grant",
          error_description: "PKCE gagal",
        });
      }
      return send(
        res,
        200,
        await issueTokens(
          c.userKey,
          c.clientId,
          f.get("scope") ?? c.scope,
          c.nonce,
        ),
        { "Content-Type": "application/json" },
      );
    }
    if (f.get("grant_type") === "refresh_token") {
      const r = refreshTokens.get(f.get("refresh_token"));
      if (!r)
        return send(res, 400, {
          error: "invalid_grant",
          error_description: "refresh token tidak valid",
        });
      return send(
        res,
        200,
        await issueTokens(r.userKey, r.clientId, f.get("scope") ?? r.scope),
        { "Content-Type": "application/json" },
      );
    }
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  if (p === `${t}/oauth2/v2.0/logout`) {
    return send(res, 302, "", {
      Location: url.searchParams.get("post_logout_redirect_uri") || "/",
    });
  }

  if (p === "/dev/token") {
    // Override untuk menguji penolakan: ttl (detik, boleh negatif), aud, tid, scp (kosong = token aplikasi)
    const q = url.searchParams;
    const userKey = q.get("user") ?? "occ";
    const u = USERS[userKey];
    if (!u)
      return send(res, 400, {
        error: "user tidak dikenal",
        users: Object.keys(USERS),
      });
    const now = Math.floor(Date.now() / 1000);
    const ttl = q.has("ttl") ? Number(q.get("ttl")) : TTL;
    const claims = {
      aud: q.get("aud") ?? API_CLIENT_ID,
      oid: u.oid,
      sub: u.oid,
      azp: SPA_CLIENT_ID ?? "dev-client",
      roles: u.roles,
      name: u.name,
      preferred_username: u.upn,
      ver: "2.0",
      tid: q.get("tid") ?? TENANT,
    };
    if (q.get("scp") !== "") claims.scp = q.get("scp") ?? "access_as_user";
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid })
      .setIssuer(ISSUER)
      .setIssuedAt(now - Math.max(0, -ttl) - 60)
      .setExpirationTime(now + ttl)
      .sign(keys.privateKey);
    return send(
      res,
      200,
      { access_token: token, expires_in: ttl, user: u },
      { "Content-Type": "application/json" },
    );
  }

  return send(res, 404, { error: "not_found" });
}

(async () => {
  keys = await generateKeyPair("RS256", { modulusLength: 2048 });
  jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: randomBytes(8).toString("hex"),
    use: "sig",
    alg: "RS256",
  };
  const server = TLS
    ? https.createServer(
        {
          cert: fs.readFileSync(process.env.MOCK_TLS_CERT),
          key: fs.readFileSync(process.env.MOCK_TLS_KEY),
        },
        handler,
      )
    : http.createServer(handler);
  server.listen(PORT, () => {
    console.log(
      `MOCK Azure AD (dev only) → ${BASE}/${TENANT} · token TTL ${TTL}s`,
    );
    console.log(
      `Pengguna uji: ${Object.entries(USERS)
        .map(([k, u]) => `${k} (${u.roles.join(",") || "tanpa role"})`)
        .join(", ")}`,
    );
  });
})();

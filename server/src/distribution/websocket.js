"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const { z } = require("zod");
const { formatScopes, scopeAllows } = require("../api/auth");
const { metrics } = require("../monitoring/metrics");
const { logger } = require("../logger");

const CHANNELS = ["telemetry", "event", "train_info"];
const EXPIRY_WARNING_MS = 2 * 60_000;

const clientMessage = z.discriminatedUnion("type", [
  // `token` = access token Azure AD atau API key; `apiKey` dipertahankan untuk kompatibilitas
  z.object({
    type: z.literal("auth"),
    token: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("subscribe"),
    channels: z.array(z.enum(CHANNELS)).min(1),
    stations: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    channels: z.array(z.enum(CHANNELS)),
  }),
  z.object({ type: z.literal("ping") }),
]);

/**
 * Distribusi realtime via WebSocket di path /ws.
 * Protokol:
 *   client → {"type":"auth","token":"<access token Azure AD atau API key>"}   (wajib dalam 10 detik)
 *   server → {"type":"auth_ok","role":"...","scopes":"...","expiresAt":"..."}
 *   client → {"type":"subscribe","channels":["event"],"stations":["LBB"]}
 *   server → {"type":"data","channel":"event","data":{...}}
 *   server → {"type":"auth_expiring","expiresAt":"..."}  2 menit sebelum token SSO habis
 *   client → {"type":"auth","token":"<token baru>"}         perpanjang tanpa memutus koneksi
 *   server menutup dengan kode 4401 bila token habis tanpa diperpanjang.
 * Kredensial dikirim sebagai pesan (bukan di URL) agar tidak tercatat di log proxy.
 */
class DistributionHub {
  /**
   * @param {import('../api/auth').Authenticator} auth
   * @param {import('../storage/repository').Repository} repo
   */
  constructor(auth, repo) {
    this.auth = auth;
    this.repo = repo;
    this.wss = null;
    this.clients = new Map();
  }

  /** @param {import('node:http').Server} server */
  attach(server) {
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: 32 * 1024,
    });
    this.wss.on("connection", (ws, req) =>
      this.onConnection(ws, req.socket.remoteAddress ?? "unknown"),
    );

    // heartbeat: putuskan klien yang tidak membalas ping
    const interval = setInterval(() => {
      for (const [ws, st] of this.clients) {
        if (!st.alive) {
          ws.terminate();
          continue;
        }
        st.alive = false;
        ws.ping();
      }
    }, 30_000);
    this.wss.on("close", () => clearInterval(interval));
  }

  onConnection(ws, ip) {
    const state = {
      auth: null,
      channels: new Set(),
      stations: null,
      ip,
      alive: true,
      warnTimer: null,
      expireTimer: null,
    };
    this.clients.set(ws, state);
    ws.on("pong", () => {
      state.alive = true;
    });

    const authTimer = setTimeout(() => {
      if (!state.auth) ws.close(4401, "auth timeout");
    }, 10_000);

    const clearExpiry = () => {
      clearTimeout(state.warnTimer);
      clearTimeout(state.expireTimer);
    };

    /** Jadwalkan peringatan & penutupan saat token SSO habis. */
    const scheduleExpiry = (ctx) => {
      clearExpiry();
      if (!ctx.expiresAt) return;
      const left = ctx.expiresAt.getTime() - Date.now();
      state.warnTimer = setTimeout(
        () =>
          this.send(ws, {
            type: "auth_expiring",
            expiresAt: ctx.expiresAt.toISOString(),
          }),
        Math.max(0, left - EXPIRY_WARNING_MS),
      );
      state.expireTimer = setTimeout(
        () => {
          this.audit(state.auth, ip, "token_expired", 401);
          ws.close(4401, "token expired");
        },
        Math.max(0, left),
      );
    };

    ws.on("message", async (buf) => {
      let msg;
      try {
        msg = clientMessage.parse(JSON.parse(buf.toString()));
      } catch {
        this.send(ws, { type: "error", error: "invalid_message" });
        return;
      }

      if (msg.type === "auth") {
        if (!msg.token && !msg.apiKey) {
          this.send(ws, { type: "error", error: "token wajib" });
          return;
        }
        let ctx = null;
        let reason = null;
        try {
          ctx = await this.auth.authenticate(msg.token ?? msg.apiKey);
        } catch (err) {
          reason = err.message;
        }
        const reauth = Boolean(state.auth);
        // Perpanjangan token tidak boleh berganti identitas di tengah koneksi
        if (ctx && reauth && ctx.clientId !== state.auth.clientId) {
          ctx = null;
          reason = "identitas berbeda dari sesi awal";
        }
        this.audit(
          ctx ?? state.auth,
          ip,
          reauth ? "reauth" : "auth",
          ctx ? 200 : 401,
          reason ? { reason } : undefined,
        );
        if (!ctx) {
          this.send(ws, { type: "auth_error", error: reason });
          ws.close(4401, "unauthorized");
          return;
        }
        state.auth = ctx;
        clearTimeout(authTimer);
        scheduleExpiry(ctx);
        metrics.wsClients.set(this.authenticatedCount());
        this.send(ws, {
          type: "auth_ok",
          role: ctx.role,
          scopes: formatScopes(ctx.scopes),
          expiresAt: ctx.expiresAt ? ctx.expiresAt.toISOString() : null,
        });
        return;
      }

      if (!state.auth) {
        this.send(ws, { type: "error", error: "unauthenticated" });
        return;
      }

      switch (msg.type) {
        case "subscribe":
          msg.channels.forEach((c) => state.channels.add(c));
          state.stations = msg.stations?.length
            ? new Set(msg.stations.map((s) => s.toUpperCase()))
            : null;
          this.audit(state.auth, ip, "subscribe", 200, {
            channels: msg.channels,
            stations: msg.stations,
          });
          this.send(ws, {
            type: "subscribed",
            channels: [...state.channels],
            stations: msg.stations ?? "*",
          });
          break;
        case "unsubscribe":
          msg.channels.forEach((c) => state.channels.delete(c));
          this.send(ws, { type: "unsubscribed", channels: msg.channels });
          break;
        case "ping":
          this.send(ws, { type: "pong", ts: new Date().toISOString() });
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      clearExpiry();
      if (state.auth) this.audit(state.auth, ip, "disconnect", 200);
      this.clients.delete(ws);
      metrics.wsClients.set(this.authenticatedCount());
    });
    ws.on("error", (err) =>
      logger.warn({ err: err.message }, "websocket error"),
    );
  }

  /**
   * Kirim record ke klien yang berlangganan channel tsb DAN record berada dalam scope-nya.
   * @param {import('../core/types').CanonicalRecord} rec
   */
  publish(rec) {
    const channel = rec.kind;
    for (const [ws, st] of this.clients) {
      if (
        !st.auth ||
        !st.channels.has(channel) ||
        ws.readyState !== WebSocket.OPEN
      )
        continue;
      if (!scopeAllows(st.auth.scopes, rec.source, rec.station)) continue;
      if (st.stations && !st.stations.has(rec.station.toUpperCase())) continue;
      if (ws.bufferedAmount > 1_000_000) continue; // klien lambat: lewati agar tidak membebani memori
      this.send(ws, { type: "data", channel, data: rec });
    }
  }

  close() {
    for (const ws of this.clients.keys()) ws.close(1001, "server shutdown");
    this.wss?.close();
  }

  send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  authenticatedCount() {
    let n = 0;
    for (const s of this.clients.values()) if (s.auth) n += 1;
    return n;
  }

  audit(ctx, ip, action, status, detail) {
    this.repo
      .insertAudit({
        clientId: ctx?.clientId,
        clientName: ctx?.clientName,
        role: ctx?.role,
        authType: ctx?.authType ?? null,
        channel: "websocket",
        method: action,
        path: "/ws",
        scopeUsed: ctx ? formatScopes(ctx.scopes) : null,
        statusCode: status,
        ip,
        detail: detail ?? null,
      })
      .catch((err) => logger.error({ err: String(err) }, "audit write failed"));
  }
}

module.exports = { DistributionHub };

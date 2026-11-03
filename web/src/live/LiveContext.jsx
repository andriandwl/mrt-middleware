import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "../auth/AuthContext";

const LiveContext = createContext(null);

/**
 * Satu koneksi WebSocket bersama untuk seluruh halaman.
 * - Autentikasi dengan token SSO terkini (atau API key) sebagai pesan pertama.
 * - Saat server mengirim `auth_expiring`, token baru diambil dari MSAL dan dikirim ulang tanpa memutus koneksi.
 * - Reconnect otomatis dengan backoff (1 dtk → maks 30 dtk).
 * Filter scope dilakukan server; komponen mendaftar listener per channel lewat useLiveChannel().
 */
export function LiveProvider({ children }) {
  const { me, getCredential } = useAuth();
  const [status, setStatus] = useState("offline"); // offline | connecting | live
  const [lastMessageAt, setLastMessageAt] = useState(null);
  const listeners = useRef({
    telemetry: new Set(),
    event: new Set(),
    train_info: new Set(),
  });
  const credRef = useRef(getCredential);
  credRef.current = getCredential;
  const identity = me ? `${me.authType}:${me.name}` : null;

  useEffect(() => {
    if (!identity) return undefined;
    let ws = null;
    let attempt = 0;
    let timer = null;
    let closedByUs = false;

    const sendAuth = async () => {
      const cred = await credRef.current().catch(() => null);
      if (cred && ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "auth", token: cred.value }));
    };

    const connect = () => {
      let subscribed = false;
      setStatus("connecting");
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => {
        sendAuth();
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "auth_ok" && !subscribed) {
          subscribed = true; // auth_ok berikutnya = perpanjangan token, langganan tetap
          ws.send(
            JSON.stringify({
              type: "subscribe",
              channels: ["telemetry", "event", "train_info"],
            }),
          );
        } else if (msg.type === "auth_expiring") {
          sendAuth(); // perpanjang token di koneksi yang sama
        } else if (msg.type === "subscribed") {
          attempt = 0;
          setStatus("live");
        } else if (msg.type === "data") {
          setLastMessageAt(Date.now());
          listeners.current[msg.channel]?.forEach((fn) => fn(msg.data));
        }
      };
      ws.onclose = () => {
        setStatus("offline");
        if (closedByUs) return;
        // termasuk 4401 (token habis): coba lagi dengan token baru dari MSAL
        const delay =
          Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(timer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const value = useMemo(
    () => ({
      status,
      lastMessageAt,
      subscribe(channel, fn) {
        listeners.current[channel].add(fn);
        return () => listeners.current[channel].delete(fn);
      },
    }),
    [status, lastMessageAt],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive harus dipakai di dalam LiveProvider");
  return ctx;
}

/** Panggil `handler(record)` setiap ada data baru di channel. Handler terbaru selalu dipakai. */
export function useLiveChannel(channel, handler) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () => subscribe(channel, (rec) => ref.current(rec)),
    [channel, subscribe],
  );
}

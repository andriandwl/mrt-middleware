import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiGet,
  getAuthConfig,
  getStoredApiKey,
  setCredentialProvider,
  storeApiKey,
} from "../api";
import { acquireApiToken, createMsal } from "./msal";

const AuthContext = createContext(null);
const RANK = { viewer: 1, operator: 2, admin: 3 };

/**
 * Sesi pengguna:
 *  - SSO Azure AD (utama): login Microsoft via MSAL, token API diperbarui otomatis.
 *  - API key (development/darurat, bila diizinkan server).
 * Identitas, role, dan scope diambil dari GET /api/v1/me.
 */
export function AuthProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [me, setMe] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);
  const msalRef = useRef(null);
  const apiKeyRef = useRef(getStoredApiKey());

  /** Kredensial aktif: token SSO bila ada akun Microsoft, selain itu API key. */
  const getCredential = useCallback(async () => {
    const msal = msalRef.current;
    if (msal?.getActiveAccount() && config?.sso) {
      const token = await acquireApiToken(msal, config.sso.apiScope);
      return token ? { type: "sso", value: token } : null;
    }
    return apiKeyRef.current
      ? { type: "api_key", value: apiKeyRef.current }
      : null;
  }, [config]);

  useEffect(() => {
    setCredentialProvider(getCredential);
  }, [getCredential]);

  // 1. Muat konfigurasi login & selesaikan redirect Microsoft (bila kembali dari halaman login)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getAuthConfig();
        if (cfg.sso?.clientId) msalRef.current = await createMsal(cfg.sso);
        if (!cancelled) setConfig(cfg);
      } catch (err) {
        if (!cancelled) {
          setError(err.message ?? "Konfigurasi login gagal dimuat.");
          setConfig({ sso: null, apiKeyLogin: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Setelah konfigurasi siap, cek sesi yang ada
  const refreshMe = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const cred = await getCredential();
      if (!cred) {
        setMe(null);
        return;
      }
      setMe(await apiGet("/me", {}, cred));
    } catch (err) {
      setMe(null);
      if (err.status === 401 && apiKeyRef.current) {
        storeApiKey(null);
        apiKeyRef.current = null;
      }
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, [getCredential]);

  useEffect(() => {
    if (config) refreshMe();
  }, [config, refreshMe]);

  const signInWithMicrosoft = useCallback(async () => {
    if (!msalRef.current || !config?.sso) return;
    await msalRef.current.loginRedirect({
      scopes: [config.sso.apiScope],
      prompt: "select_account",
    });
  }, [config]);

  /** Validasi API key ke server dulu; hanya disimpan bila diterima. */
  const signInWithApiKey = useCallback(async (key) => {
    const data = await apiGet("/me", {}, { type: "api_key", value: key });
    storeApiKey(key);
    apiKeyRef.current = key;
    setError(null);
    setMe(data);
  }, []);

  const signOut = useCallback(async () => {
    const msal = msalRef.current;
    storeApiKey(null);
    apiKeyRef.current = null;
    setMe(null);
    if (msal?.getActiveAccount()) {
      await msal.logoutRedirect({ account: msal.getActiveAccount() });
    }
  }, []);

  const value = useMemo(
    () => ({
      config,
      me,
      checking: !config || checking,
      error,
      ssoAccount: msalRef.current?.getActiveAccount() ?? null,
      signInWithMicrosoft,
      signInWithApiKey,
      signOut,
      getCredential,
      hasRole: (min) => Boolean(me && RANK[me.role] >= RANK[min]),
    }),
    [
      config,
      me,
      checking,
      error,
      signInWithMicrosoft,
      signInWithApiKey,
      signOut,
      getCredential,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth harus dipakai di dalam AuthProvider");
  return ctx;
}

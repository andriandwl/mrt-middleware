/**
 * Klien REST ke middleware.
 * Header autentikasi disediakan oleh AuthContext lewat setCredentialProvider():
 *  - SSO Azure AD: Authorization: Bearer <access token> (diperbarui otomatis oleh MSAL)
 *  - API key (development/darurat): X-API-Key, disimpan di sessionStorage (hilang saat tab ditutup)
 */
const KEY_STORAGE = "mrtmw.apiKey";

export function getStoredApiKey() {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function storeApiKey(key) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage tidak tersedia: key hanya hidup di memori */
  }
}

/** @type {null | (() => Promise<{ type: 'sso'|'api_key', value: string } | null>)} */
let credentialProvider = null;

export function setCredentialProvider(fn) {
  credentialProvider = fn;
}

/** Kredensial terkini (token SSO segar atau API key), untuk REST maupun WebSocket. */
export async function getCredential() {
  return credentialProvider ? credentialProvider() : null;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ERROR_TEXT = {
  401: "Sesi tidak valid atau sudah berakhir. Silakan masuk lagi.",
  403: "Role atau scope Anda tidak mencakup data ini.",
  400: "Filter tidak valid.",
};

function headersFor(cred) {
  if (!cred) return {};
  return cred.type === "sso"
    ? { Authorization: `Bearer ${cred.value}` }
    : { "X-API-Key": cred.value };
}

/** GET /api/v1/<path> dengan query params; nilai kosong diabaikan. `cred` opsional untuk memaksa kredensial tertentu. */
export async function apiGet(path, params = {}, cred) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  });
  const url = `/api/v1${path}${qs.toString() ? `?${qs}` : ""}`;
  const credential = cred ?? (await getCredential());
  let res;
  try {
    res = await fetch(url, { headers: headersFor(credential) });
  } catch {
    throw new ApiError(0, "Server middleware tidak dapat dihubungi.");
  }
  if (!res.ok) {
    let detail = null;
    try {
      detail = (await res.json()).detail ?? null;
    } catch {
      /* body bukan JSON */
    }
    throw new ApiError(
      res.status,
      detail && res.status === 403
        ? `${detail}.`
        : (ERROR_TEXT[res.status] ?? `Server membalas ${res.status}.`),
    );
  }
  const body = await res.json();
  return body.data;
}

/** Konfigurasi login (publik): SSO Azure AD aktif? form API key ditampilkan? */
export async function getAuthConfig() {
  const res = await fetch("/api/v1/auth/config");
  if (!res.ok)
    throw new ApiError(res.status, "Konfigurasi login tidak dapat dimuat.");
  return (await res.json()).data;
}

/** Endpoint publik /ready: status database & konektor. */
export async function getReady() {
  const res = await fetch("/ready");
  return res.json();
}

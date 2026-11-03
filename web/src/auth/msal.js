import { InteractionRequiredAuthError, LogLevel, PublicClientApplication } from '@azure/msal-browser';

const debugAuth = () => {
  try {
    return localStorage.getItem('mrtmw.debugAuth') === '1';
  } catch {
    return false;
  }
};

/**
 * Inisialisasi MSAL (Microsoft Authentication Library) dari konfigurasi server (/api/v1/auth/config).
 * Konfigurasi diambil saat runtime, sehingga satu build UI bisa dipakai di dev/staging/produksi.
 */
export async function createMsal(sso) {
  const authorityUrl = new URL(sso.authority);
  const isMicrosoft = authorityUrl.host === 'login.microsoftonline.com';
  const msal = new PublicClientApplication({
    auth: {
      clientId: sso.clientId,
      authority: sso.authority,
      redirectUri: window.location.origin,
      postLogoutRedirectUri: window.location.origin,
      navigateToLoginRequestUrl: true,
      // authority non-Microsoft hanya untuk mock lokal
      ...(isMicrosoft ? {} : { knownAuthorities: [authorityUrl.host] }),
    },
    cache: { cacheLocation: 'sessionStorage' },
    system: {
      tokenRenewalOffsetSeconds: 300,
      // Log MSAL ke console bila localStorage 'mrtmw.debugAuth' = '1' (untuk troubleshooting login)
      loggerOptions: {
        piiLoggingEnabled: false,
        logLevel: debugAuth() ? LogLevel.Verbose : LogLevel.Warning,
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;
          if (level <= LogLevel.Warning || debugAuth()) console.warn(`[msal] ${message}`);
        },
      },
    },
  });
  await msal.initialize();
  const result = await msal.handleRedirectPromise();
  const account = result?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  if (account) msal.setActiveAccount(account);
  return msal;
}

/** Ambil access token API secara diam-diam; bila perlu interaksi, alihkan ke halaman login Microsoft. */
export async function acquireApiToken(msal, apiScope) {
  const account = msal.getActiveAccount();
  if (!account) return null;
  const request = { scopes: [apiScope], account };
  try {
    const r = await msal.acquireTokenSilent(request);
    return r.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect(request);
      return null;
    }
    throw err;
  }
}

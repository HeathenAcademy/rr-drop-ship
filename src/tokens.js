import fs from 'node:fs/promises';
import path from 'node:path';
import { refreshAccessToken } from './aliexpress.js';

// Token store with automatic refresh.
// AliExpress (her app's Auth Management settings) issues short-lived
// tokens: access ~24h, refresh ~48h. Refreshing ROTATES both tokens and
// restarts their clocks, so as long as the app refreshes before the
// refresh token lapses, authorization stays alive indefinitely.
// Tokens persist to a JSON file (survives restarts on the same instance);
// env vars are the bootstrap/fallback seed after a fresh deploy.
const storePath = () => process.env.TOKEN_STORE_PATH || path.resolve('data/tokens.json');
let cache = null;
let refreshing = null;

export async function loadTokens() {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(storePath(), 'utf8')); }
  catch {
    cache = {
      accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN || null,
      refreshToken: process.env.ALIEXPRESS_REFRESH_TOKEN || null,
      // Unknown seed expiry: 0 forces a refresh attempt on first use when
      // a refresh token exists (safe — a failed refresh still falls back).
      accessExpiresAt: 0, refreshExpiresAt: 0,
    };
  }
  return cache;
}

export async function saveTokens(patch) {
  cache = { ...(await loadTokens()), ...patch };
  try {
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify(cache, null, 1));
  } catch { /* persistence is best-effort; in-memory cache still works */ }
  return cache;
}

export const tokenStatus = async () => {
  const t = await loadTokens();
  return {
    authorized: Boolean(t.accessToken || t.refreshToken),
    access_expires_at: t.accessExpiresAt ? new Date(t.accessExpiresAt).toISOString() : null,
    refresh_expires_at: t.refreshExpiresAt ? new Date(t.refreshExpiresAt).toISOString() : null,
  };
};

// Map a token-endpoint response (create or refresh) into store fields.
export const tokensFromResponse = (tok) => ({
  accessToken: tok.access_token,
  refreshToken: tok.refresh_token,
  accessExpiresAt: tok.expire_time || (Date.now() + (tok.expires_in || 0) * 1000),
  refreshExpiresAt: tok.refresh_token_valid_time || (Date.now() + (tok.refresh_expires_in || 0) * 1000),
});

export async function getValidAccessToken(cfg, { now = Date.now(), refreshFn = refreshAccessToken, skewMs = 3600_000 } = {}) {
  const t = await loadTokens();
  const accessFresh = t.accessToken && t.accessExpiresAt - now > skewMs;
  // Also refresh while the REFRESH token is in its last day even when the
  // access token still looks fresh: the first post-authorization refresh
  // returned a long-lived (30-day) access token but kept the ORIGINAL
  // 48h refresh deadline. Rolling early is how the chain stays alive.
  const refreshUrgent = t.refreshExpiresAt && t.refreshExpiresAt - now <= 24 * 3600_000;
  if (accessFresh && !refreshUrgent) return t.accessToken;
  if (!t.refreshToken) return t.accessToken; // nothing to refresh with
  if (t.refreshExpiresAt && t.refreshExpiresAt <= now) return t.accessToken; // refresh lapsed; caller will surface the API error
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const out = await refreshFn(t.refreshToken, cfg);
        if (out?.access_token) { await saveTokens(tokensFromResponse(out)); return out.access_token; }
        return null;
      } catch { return null; }
      finally { refreshing = null; }
    })();
  }
  return (await refreshing) || t.accessToken;
}

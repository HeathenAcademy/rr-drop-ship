import crypto from 'node:crypto';

// AliExpress Open Platform signing: sort params, HMAC-SHA256 with app_secret
export function sign(params, appSecret) {
  const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', appSecret).update(sorted).digest('hex').toUpperCase();
}

// Business APIs on the new platform are IOP REST calls:
//   POST https://api-sg.aliexpress.com/rest/<method with dots as slashes>
// signed exactly like the auth calls (see iopSign below). `session` carries
// the access token. (An older TOP-style /sync variant is kept out on
// purpose — the legacy platform does not know this app.)
export function buildIopRequest(method, extra, { appKey, appSecret, accessToken }) {
  const apiPath = '/' + method.replace(/\./g, '/');
  const params = { app_key: appKey, timestamp: String(Date.now()), sign_method: 'sha256', ...extra };
  if (accessToken) params.session = accessToken;
  params.sign = iopSign(apiPath, params, appSecret);
  return { url: `https://api-sg.aliexpress.com/rest${apiPath}`, params };
}

export async function callAliExpress(method, extra, cfg) {
  const { url, params } = buildIopRequest(method, extra, cfg);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`AliExpress ${method} returned HTTP ${res.status} with non-JSON body: ${text.slice(0, 200)}`); }
}

// Accept a full AliExpress product URL (any slug/query form) or a bare
// numeric product ID, and return just the ID. Throws on anything else.
export function extractProductId(input) {
  const s = String(input || '').trim();
  if (/^\d{6,}$/.test(s)) return s;
  const patterns = [/\/item\/(?:[^/]+\/)?(\d{6,})\.html/, /[?&](?:product_?id|productId)=(\d{6,})/i, /\/item\/(\d{6,})/];
  for (const re of patterns) { const m = s.match(re); if (m) return m[1]; }
  throw new Error('Could not find an AliExpress product ID in that - paste the product link or the numeric ID');
}

export const getDsProduct = (productId, opts) =>
  callAliExpress('aliexpress.ds.product.get', { product_id: productId }, opts);

// OAuth: our app sends the account owner to AliExpress to authorize.
// AliExpress redirects back to our callback with ?code=..., which the
// server exchanges for an access_token + refresh_token.
//
// PLATFORM NOTE (verified from her portal docs 2026-10-20): this app lives
// on the NEW AliExpress open platform. The authorize page is on
// api-sg.aliexpress.com — the legacy oauth.aliexpress.com host answers
// "param-appkey not exists" for new-platform apps. Token exchange is a
// SIGNED IOP call to /auth/token/create (refresh: /auth/token/refresh),
// not the legacy /token form post.
export function buildAuthUrl({ appKey, redirectUri }) {
  const u = new URL('https://api-sg.aliexpress.com/oauth/authorize');
  u.search = new URLSearchParams({
    response_type: 'code', force_auth: 'true',
    redirect_uri: redirectUri, client_id: appKey,
  });
  return u.toString();
}

// IOP signing: sort params, prepend the API path, HMAC-SHA256, uppercase hex.
export function iopSign(apiPath, params, secret) {
  const keys = Object.keys(params).filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '').sort();
  const str = apiPath + keys.map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}

async function iopAuthCall(apiPath, bizParams, { appKey, appSecret }) {
  const sys = { app_key: appKey, timestamp: String(Date.now()), sign_method: 'sha256' };
  const all = { ...sys, ...bizParams };
  const sign = iopSign(apiPath, all, appSecret);
  // Gateway is /rest + apiPath, but the SIGNATURE is computed over apiPath
  // alone (both facts verified live 2026-10-20: wrong combo returns
  // IncompleteSignature; right combo reaches the business error InvalidCode).
  const res = await fetch(`https://api-sg.aliexpress.com/rest${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...all, sign }),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`AliExpress ${apiPath} returned HTTP ${res.status} with non-JSON body: ${text.slice(0, 200)}`); }
}

export const exchangeCodeForToken = (code, cfg) =>
  iopAuthCall('/auth/token/create', { code }, cfg);
export const refreshAccessToken = (refreshToken, cfg) =>
  iopAuthCall('/auth/token/refresh', { refresh_token: refreshToken }, cfg);

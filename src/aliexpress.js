import crypto from 'node:crypto';

// AliExpress Open Platform signing: sort params, HMAC-SHA256 with app_secret
export function sign(params, appSecret) {
  const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', appSecret).update(sorted).digest('hex').toUpperCase();
}

export async function callAliExpress(method, extra, { appKey, appSecret, accessToken, host }) {
  const params = {
    method, app_key: appKey, timestamp: String(Date.now()),
    format: 'json', v: '2.0', sign_method: 'sha256', ...extra,
  };
  if (accessToken) params.session = accessToken;
  params.sign = sign(params, appSecret);
  const res = await fetch(`https://${host}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return res.json();
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
export function buildAuthUrl({ appKey, redirectUri }) {
  const u = new URL('https://oauth.aliexpress.com/authorize');
  u.search = new URLSearchParams({
    response_type: 'code', force_auth: 'true',
    redirect_uri: redirectUri, client_id: appKey, sp: 'ae',
  });
  return u.toString();
}

export async function exchangeCodeForToken(code, { appKey, appSecret, redirectUri }) {
  const res = await fetch('https://oauth.aliexpress.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      client_id: appKey, client_secret: appSecret, redirect_uri: redirectUri,
    }),
  });
  return res.json();
}

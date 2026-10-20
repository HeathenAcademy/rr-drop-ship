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

export const getDsProduct = (productId, opts) =>
  callAliExpress('aliexpress.ds.product.get', { product_id: productId }, opts);

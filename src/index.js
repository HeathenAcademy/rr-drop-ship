import 'dotenv/config';
import express from 'express';
import { getDsProduct, buildAuthUrl, exchangeCodeForToken } from './aliexpress.js';
import { toSquareCatalog, upsertCatalog } from './square.js';

const app = express();
app.use(express.json());
const ali = { appKey: process.env.ALIEXPRESS_APP_KEY, appSecret: process.env.ALIEXPRESS_APP_SECRET,
  accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN, host: process.env.ALIEXPRESS_API_HOST || 'api-sg.aliexpress.com' };
const sq = { token: process.env.SQUARE_ACCESS_TOKEN, environment: process.env.SQUARE_ENVIRONMENT || 'sandbox' };

app.get('/health', (_req, res) => res.json({ ok: true, app: 'RR Drop Ship' }));

const callbackUri = () => `${process.env.PUBLIC_BASE_URL}/auth/aliexpress/callback`;

// Visit this to START AliExpress authorization (app sends you to AliExpress)
app.get('/auth/aliexpress/start', (_req, res) => {
  res.redirect(buildAuthUrl({ appKey: ali.appKey, redirectUri: callbackUri() }));
});

// Put this full URL in the AliExpress portal as the Callback URL
app.get('/auth/aliexpress/callback', async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send(`AliExpress returned: ${req.query.error}`);
    if (!req.query.code) return res.status(400).send('No code in callback');
    const token = await exchangeCodeForToken(req.query.code, {
      appKey: ali.appKey, appSecret: ali.appSecret, redirectUri: callbackUri(),
    });
    if (!token.access_token) return res.status(502).json({ error: 'Token exchange failed', aliexpress: token });
    // Setup phase: display the token JSON once to the authorizing browser
    // so it can be saved into this service's ALIEXPRESS_ACCESS_TOKEN env
    // var on Render. Long-term the token should be stored in a DB instead.
    res.json({ ok: true, message: 'Authorization succeeded', ...token });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.post('/sync/product', async (req, res) => {
  try {
    const raw = await getDsProduct(req.body.product_id, ali);
    const catalogObj = toSquareCatalog(raw, {
      markup: Number(req.body.markup || process.env.PRICE_MARKUP || 1.8),
      round99: process.env.ROUND_TO_99 === 'true', locationId: process.env.SQUARE_LOCATION_ID,
    });
    res.json({ aliexpress: raw, square: await upsertCatalog(catalogObj, sq) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.post('/webhooks/square', (req, res) => {
  // Flow Alexia chose: a Square sale of a dropship item (flagged by
  // category "AliExpress Dropship" / SKU prefix AE-, inventory NOT tracked)
  // triggers an AliExpress DS order, and AliExpress
  // ships it directly to the customer. Verify Square signature first,
  // then look up each line item's AliExpress product_id in our mapping
  // and create the DS order. Exact DS order method/params to be confirmed
  // in the AliExpress portal's API Explorer before going live.
  console.log('Square webhook:', req.body?.type);
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('RR Drop Ship listening'));

import 'dotenv/config';
import express from 'express';
import { getDsProduct } from './aliexpress.js';
import { toSquareCatalog, upsertCatalog } from './square.js';

const app = express();
app.use(express.json());
const ali = { appKey: process.env.ALIEXPRESS_APP_KEY, appSecret: process.env.ALIEXPRESS_APP_SECRET,
  accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN, host: process.env.ALIEXPRESS_API_HOST || 'api-sg.aliexpress.com' };
const sq = { token: process.env.SQUARE_ACCESS_TOKEN, environment: process.env.SQUARE_ENVIRONMENT || 'sandbox' };

app.get('/health', (_req, res) => res.json({ ok: true, app: 'RR Drop Ship' }));

// Put this full URL in the AliExpress portal as the Callback URL
app.get('/auth/aliexpress/callback', (req, res) => {
  // AliExpress returns a code here; exchange it for an access token, store securely.
  console.log('AliExpress callback:', req.query);
  res.send('RR Drop Ship: authorization received. You can close this tab.');
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

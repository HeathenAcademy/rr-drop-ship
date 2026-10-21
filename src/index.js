import 'dotenv/config';
import express from 'express';
import { getDsProduct, buildAuthUrl, exchangeCodeForToken, extractProductId } from './aliexpress.js';
import { toSquareCatalog, upsertCatalog, syncVariantProduct } from './square.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const ali = { appKey: process.env.ALIEXPRESS_APP_KEY, appSecret: process.env.ALIEXPRESS_APP_SECRET,
  accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN, host: process.env.ALIEXPRESS_API_HOST || 'api-sg.aliexpress.com' };
const sq = { token: process.env.SQUARE_ACCESS_TOKEN, environment: process.env.SQUARE_ENVIRONMENT || 'sandbox' };

app.get('/health', (_req, res) => res.json({ ok: true, app: 'RR Drop Ship' }));

// Forgive stray spaces in URLs (a copied link added "%20" before "start"
// once and produced Cannot GET). Redirect to the cleaned path.
app.use((req, res, next) => {
  if (req.path.includes(' ')) return res.redirect(req.path.replace(/ /g, ''));
  next();
});

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

async function syncProduct(productInput, markupInput) {
  const productId = extractProductId(productInput);
  const raw = await getDsProduct(productId, ali);
  const wrap = raw?.aliexpress_ds_product_get_response;
  if (!wrap) throw new Error(`AliExpress returned no product wrapper: ${JSON.stringify(raw).slice(0, 300)}`);
  if (wrap.rsp_code && Number(wrap.rsp_code) !== 200) throw new Error(`AliExpress rsp ${wrap.rsp_code}: ${wrap.rsp_msg || ''}`);
  const opts = {
    markup: Number(markupInput || process.env.PRICE_MARKUP || 1.8),
    round99: process.env.ROUND_TO_99 === 'true', locationId: process.env.SQUARE_LOCATION_ID,
  };
  // Products with SKUs (clothes: sizes/colors) go in as structured
  // options + one variation per SKU, each with its own AliExpress price.
  const variantResult = await syncVariantProduct(raw, opts, sq);
  if (variantResult) return { productId, variants: variantResult.variants, square: variantResult.square };
  const square = await upsertCatalog(toSquareCatalog(raw, opts), sq);
  return { productId, square };
}

app.post('/sync/product', async (req, res) => {
  try { res.json(await syncProduct(req.body.product_id, req.body.markup)); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---- Simple import page (for Alexia, no code needed) ----
const page = (inner) => `<!doctype html><html><head><meta charset="utf-8"><title>RR Drop Ship - Import</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}input{width:100%;padding:10px;margin:6px 0 14px}button{padding:10px 18px;font-size:16px}.ok{background:#e6f7e6;padding:12px}.err{background:#fdecec;padding:12px}</style></head><body>
<h1>Retail Resurrection - Import from AliExpress</h1>${inner}</body></html>`;
const form = `<form method="POST" action="/import">
<label>AliExpress product link (or product ID)<input name="product" required placeholder="https://www.aliexpress.com/item/...html"></label>
<label>Markup (optional, e.g. 1.8 = cost x 1.8)<input name="markup" placeholder="1.8"></label>
<button type="submit">Import into Square</button></form>
<p>The item lands in Square under your Retail Resurrection location, inventory tracking off, ready to sell. AliExpress fulfills it when it sells.</p>`;

app.get('/', (_req, res) => res.send(page(form)));
app.post('/import', async (req, res) => {
  try {
    const { productId, square, variants } = await syncProduct(req.body.product, req.body.markup);
    const obj = square.catalog_object || (square.objects || []).find(o => o.type === 'ITEM');
    const varTxt = variants ? ` with ${variants.length} variants (${variants.map(v => `${v.name} $${(v.price_cents / 100).toFixed(2)}, AliExpress stock ${v.stock}`).join('; ')})` : '';
    res.send(page(`<div class="ok"><b>Imported!</b> AliExpress product ${productId} is now in Square as item <b>${obj?.id || ''}</b> (${obj?.item_data?.name || ''})${varTxt}.</div>` + form));
  } catch (e) {
    res.send(page(`<div class="err"><b>Import didn't finish:</b> ${String(e.message || e)}</div>` + form));
  }
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

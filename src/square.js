import crypto from 'node:crypto';
const base = (env) => env === 'production'
  ? 'https://connect.squareup.com/v2'
  : 'https://connect.squareupsandbox.com/v2';

export async function square(path, body, { token, environment }) {
  const res = await fetch(`${base(environment)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square ${path}: ${JSON.stringify(data.errors || data)}`);
  return data;
}

export const priceCents = (cost, markup, round99) => {
  let cents = Math.round(Number(cost || 0) * markup * 100);
  if (round99 && cents >= 100) cents = Math.floor(cents / 100) * 100 + 99;
  return cents;
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

// ---- AliExpress SKU / variant parsing ----
// DS product SKUs live at result.aeop_ae_product_skus.ae_product_sku[].
// Each SKU: id, offer_sale_price/sku_price, ipm_sku_stock/sku_available_stock,
// and properties (Color: Black, Size: M...) as aeop_sku_property_list entries
// or the encoded sku_attr string ("14:29#Black;5:100014064#M").
export function parseSkus(p) {
  const list = p?.aeop_ae_product_skus?.ae_product_sku || p?.aeop_ae_product_skus || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.filter(Boolean).map((sku) => {
    let props = [];
    const plist = sku.aeop_sku_property_list?.ae_sku_property || sku.aeop_sku_property_list || [];
    for (const pr of (Array.isArray(plist) ? plist : [plist])) {
      if (pr?.sku_property_name && pr?.sku_property_value) {
        props.push({ name: pr.sku_property_name, value: pr.sku_property_value, image: pr.sku_image || null });
      }
    }
    if (!props.length && sku.sku_attr) { // fallback: decode "id:id#Value;id:id#Value"
      props = String(sku.sku_attr).split(';').map(seg => {
        const m = seg.match(/#(.+)$/); return m ? { name: 'Option', value: m[1], image: null } : null;
      }).filter(Boolean);
    }
    const stock = Number(sku.ipm_sku_stock ?? sku.sku_available_stock ?? sku.stock ?? 0);
    return {
      skuId: String(sku.id || sku.sku_id || ''),
      props,
      cost: Number(sku.offer_sale_price || sku.sku_price || sku.discount_price || 0),
      stock: Number.isFinite(stock) ? stock : 0,
    };
  });
}

// Build a full Square batch-upsert (options + item + one variation per SKU)
// for a product WITH variants. Falls back gracefully in callers when empty.
// IMPORTANT (learned live 2026-10-20): Square ITEM_OPTIONs are account-global
// - a "Color" or "Size" option usually already exists and Square rejects
// creating a duplicate name. `existingOptions` = the account's current
// ITEM_OPTION catalog objects; existing options/values are REUSED by name,
// and an update object (with version) appends any missing values instead.
export const unwrapDsProduct = (dsProduct) =>
  dsProduct?.aliexpress_ds_product_get_response?.result || dsProduct?.result ||
  (dsProduct?.product_title ? dsProduct : null);

export function toSquareVariantBatch(dsProduct, { markup = 1.8, round99 = true, locationId }, existingOptions = []) {
  const p = unwrapDsProduct(dsProduct);
  if (!p) throw new Error('Unexpected AliExpress product shape — check raw response first');
  const skus = parseSkus(p);
  if (!skus.length) return null;

  const existingByName = new Map();
  for (const o of existingOptions || []) {
    const d = o.item_option_data || {};
    if (d.name) existingByName.set(d.name.toLowerCase(), o);
  }

  // Collect structured options (Color, Size...) in first-seen order
  const options = new Map(); // name -> Map(value -> {image})
  for (const sku of skus) for (const pr of sku.props) {
    if (!options.has(pr.name)) options.set(pr.name, new Map());
    if (!options.get(pr.name).has(pr.value)) options.get(pr.name).set(pr.value, pr);
  }
  const optionObjects = [];
  const optionIds = new Map(); const valueIds = new Map();
  for (const [name, values] of options) {
    const existing = existingByName.get(name.toLowerCase());
    if (existing) {
      const oid = existing.id;
      optionIds.set(name, oid);
      const exVals = new Map();
      for (const v of existing.item_option_data.values || []) {
        const vd = v.item_option_value_data || {};
        if (vd.name) exVals.set(vd.name, v);
      }
      const vals = [];
      // carry existing values through on the update object
      for (const [, v] of exVals) {
        vals.push({ type: 'ITEM_OPTION_VAL', id: v.id, version: v.version,
          item_option_value_data: { item_option_id: oid, name: v.item_option_value_data.name, ordinal: v.item_option_value_data.ordinal } });
        valueIds.set(`${name}=${v.item_option_value_data.name}`, v.id);
      }
      let changed = false;
      for (const [value] of values) {
        if (exVals.has(value)) continue;
        changed = true;
        const vid = `#optval-${slug(name)}-${slug(value)}`;
        valueIds.set(`${name}=${value}`, vid);
        vals.push({ type: 'ITEM_OPTION_VAL', id: vid, item_option_value_data: { item_option_id: oid, name: value } });
      }
      if (changed) { // only upsert the option when appending new values
        optionObjects.push({ type: 'ITEM_OPTION', id: oid, version: existing.version,
          item_option_data: { name: existing.item_option_data.name, display_name: existing.item_option_data.display_name,
            show_colors: existing.item_option_data.show_colors, values: vals } });
      }
      continue;
    }
    const oid = `#opt-${slug(name)}`;
    optionIds.set(name, oid);
    const vals = [];
    for (const [value] of values) {
      const vid = `${oid}-${slug(value)}`;
      valueIds.set(`${name}=${value}`, vid);
      vals.push({ type: 'ITEM_OPTION_VAL', id: vid, item_option_value_data: { item_option_id: oid, name: value } });
    }
    optionObjects.push({ type: 'ITEM_OPTION', id: oid, item_option_data: { name, display_name: name, show_colors: /color|colour/i.test(name), values: vals } });
  }

  const summary = [];
  const variations = skus.map((sku, i) => {
    const name = sku.props.map(pr => pr.value).join(' / ') || `Variant ${i + 1}`;
    const cents = priceCents(sku.cost, markup, round99);
    summary.push({ aliexpress_sku_id: sku.skuId, name, price_cents: cents, stock: sku.stock });
    return {
      type: 'ITEM_VARIATION', id: `#rr-var-${i}`,
      present_at_all_locations: false, present_at_location_ids: [locationId],
      item_variation_data: {
        item_id: '#rr-item', name, pricing_type: 'FIXED_PRICING',
        price_money: { amount: cents, currency: 'USD' },
        sku: sku.skuId ? `AE-${sku.skuId}` : undefined,
        track_inventory: false, // stock is AliExpress's; availability gated by `sellable`
        // NOTE: do NOT set stockable:false — Square then demands a
        // composition reference (live test error 2026-10-20). Omit it.
        sellable: sku.stock > 0,
        item_option_values: sku.props.map(pr => ({
          item_option_id: optionIds.get(pr.name), item_option_value_id: valueIds.get(`${pr.name}=${pr.value}`),
        })),
      },
    };
  });

  const item = {
    type: 'ITEM', id: '#rr-item',
    present_at_all_locations: false, present_at_location_ids: [locationId],
    item_data: {
      name: String(p.product_title || 'Imported product').slice(0, 512),
      description: p.product_detail_url || '',
      item_options: [...optionIds.values()].map(id => ({ item_option_id: id })),
      variations,
    },
  };
  return {
    request: { idempotency_key: crypto.randomUUID(), batches: [{ objects: [...optionObjects, item] }] },
    summary, // per-SKU price + AliExpress stock at import time (snapshot)
  };
}

// Simple fallback: single-variation item for products without SKUs
export function toSquareCatalog(dsProduct, { markup = 1.8, round99 = true, locationId }) {
  const p = unwrapDsProduct(dsProduct);
  if (!p) throw new Error('Unexpected AliExpress product shape — check raw response first');
  const cents = priceCents(p.target_sale_price || p.target_original_price || 0, markup, round99);
  return {
    idempotency_key: crypto.randomUUID(),
    object: {
      type: 'ITEM', id: '#rr-item',
      present_at_all_locations: false, present_at_location_ids: [locationId],
      item_data: {
        name: String(p.product_title || 'Imported product').slice(0, 512),
        description: p.product_detail_url || '',
        variations: [{
          type: 'ITEM_VARIATION', id: '#rr-var',
          present_at_all_locations: false, present_at_location_ids: [locationId],
          item_variation_data: {
            item_id: '#rr-item', name: 'Regular', pricing_type: 'FIXED_PRICING',
            price_money: { amount: cents, currency: 'USD' },
            track_inventory: false,
          },
        }],
      },
    },
  };
}
export const upsertCatalog = (obj, cfg) => square('/catalog/object', obj, cfg);
export const batchUpsertCatalog = (req, cfg) => square('/catalog/batch-upsert', req, cfg);

export async function fetchExistingOptions(cfg) {
  const all = []; let cursor;
  do {
    const res = await square('/catalog/search', { object_types: ['ITEM_OPTION'], limit: 100, ...(cursor ? { cursor } : {}) }, cfg);
    all.push(...(res.objects || [])); cursor = res.cursor;
  } while (cursor);
  return all;
}

// Full variant import: reuse the account's global options, then batch-upsert.
export async function syncVariantProduct(raw, opts, cfg) {
  const existing = await fetchExistingOptions(cfg);
  const batch = toSquareVariantBatch(raw, opts, existing);
  if (!batch) return null;
  const squareRes = await batchUpsertCatalog(batch.request, cfg);
  return { square: squareRes, variants: batch.summary };
}

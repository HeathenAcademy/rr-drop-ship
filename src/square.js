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

// Transform an AliExpress DS product into a Square Catalog ITEM + variation
export function toSquareCatalog(dsProduct, { markup = 1.8, round99 = true, locationId }) {
  const p = dsProduct?.aliexpress_ds_product_get_response?.result;
  if (!p) throw new Error('Unexpected AliExpress product shape — check raw response first');
  const cost = Number(p.target_sale_price || p.target_original_price || 0);
  let cents = Math.round(cost * markup * 100);
  if (round99) cents = Math.floor(cents / 100) * 100 + 99;
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
          item_variation_data: {
            item_id: '#rr-item', name: 'Regular', pricing_type: 'FIXED_PRICING',
            price_money: { amount: cents, currency: 'USD' },
            // Key trick instead of a paid 2nd location: do NOT track
            // inventory in Square for dropship items. Square stock stays
            // clean; availability is synced from AliExpress by this app.
            track_inventory: false,
          },
        }],
      },
    },
  };
}
export const upsertCatalog = (obj, cfg) => square('/catalog/object', obj, cfg);

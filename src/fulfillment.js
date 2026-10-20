// The fulfillment location for RR Drop Ship.
//
// This is a dedicated fulfillment location whose ONLY job is sending
// orders to AliExpress to be fulfilled by AliExpress sellers and shipped
// directly to the customer. It is NOT Alexia's physical store.
//
// In Square an order's fulfillment is what carries the recipient +
// shipment details. When a Square order contains a dropship line item,
// this module converts that fulfillment into an AliExpress DS order.
//
// NOTE on Square billing: creating a second *store* Location in Square
// can trigger a per-location charge on paid plans. The browser task
// checks the Locations flow and must NOT accept a billing change
// silently — if Square shows a charge, it reports the amount first.
// The routing below works the same whether fulfillment lives in a real
// Square location, a deactivated/mobile location, or is tracked by this
// app against her existing location.

export const FULFILLMENT_LOCATION = {
  key: 'aliexpress-fulfillment',
  name: 'Retail Resurrection - AliExpress Fulfillment',
  type: 'FULFILLMENT', // not a walk-in store
  fulfiller: 'AliExpress',
  inventoryTracked: false, // AliExpress holds the stock
  // Imported products are assigned to this fulfillment location and
  // flagged: category "AliExpress Dropship", SKU prefix "AE-"
};

export function routeOrderToAliExpress(squareOrder, mappingByCatalogId) {
  const fulfillment = squareOrder?.fulfillments?.[0];
  const ship = fulfillment?.shipment_details;
  const recipient = ship?.recipient;
  if (!recipient?.address) {
    throw new Error('Square order has no shipping address — dropship items must be Shipping-only (not Pickup) so an address is collected');
  }
  const items = (squareOrder.line_items || [])
    .filter(li => mappingByCatalogId[li.catalog_object_id])
    .map(li => ({
      product_id: mappingByCatalogId[li.catalog_object_id].aliexpress_product_id,
      sku_attr: mappingByCatalogId[li.catalog_object_id].aliexpress_sku_attr || '',
      quantity: Number(li.quantity || 1),
    }));
  if (!items.length) return null; // not a dropship order, nothing to send
  return {
    // Exact DS order method + param names to be confirmed in the
    // AliExpress portal API Explorer for Alexia's granted APIs.
    logistics_address: {
      full_name: recipient.display_name,
      address: [recipient.address.address_line_1, recipient.address.address_line_2].filter(Boolean).join(' '),
      city: recipient.address.locality,
      province: recipient.address.administrative_district_level_1,
      zip: recipient.address.postal_code,
      country: recipient.address.country,
      phone_country: '+1',
      mobile_no: recipient.phone_number || '',
    },
    product_items: items,
  };
}

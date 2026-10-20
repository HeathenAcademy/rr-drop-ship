# RR Drop Ship — AliExpress <> Square for Retail Resurrection

Middleware server that sits between AliExpress (Alexia's developer app
"RR Drop Ship", Drop Shipping category, status: Test) and Square for
Retail Resurrection (in-person store, retailresurrection.com).

## What it does
1. Receives AliExpress authorization callbacks and stores the dropshipper access token
2. Fetches AliExpress dropshipping products (aliexpress.ds.product.get)
3. Transforms them (title, images, variants, price x markup) into Square Catalog items
4. Upserts them to Square (Catalog API) and sets inventory (Inventory API)
5. Listens for Square order webhooks, creates the AliExpress DS order for fulfillment

## Architecture
AliExpress Open Platform (api-sg.aliexpress.com/sync, HMAC-SHA256 signed)
  <-> this server (Node / Express)
  <-> Square APIs (connect.squareup.com/v2, Bearer token)

## Run locally
cp .env.example .env  # fill values from the Secure Vault, never commit .env
npm install
npm start             # http://localhost:3000/health

## Endpoints
- GET  /health
- GET  /auth/aliexpress/callback   <- put THIS full URL in AliExpress portal as Callback URL
- POST /sync/product               { "product_id": "...", "markup": 1.8 }
- POST /webhooks/square            Square order/inventory webhook receiver

## Go-live checklist
See SETUP_CHECKLIST.md

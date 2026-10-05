# orders-service

Orders microservice for the Audiophile store. The project currently contains
the application skeleton, request validation, products API integration, and order
totals calculation. API routes and database access are not implemented yet.

## Requirements

- Node.js 22.12 or newer
- npm

## Local development

Run `npm install`, then create a local `.env` based on `.env.example`.
Run `npm run dev` to start the development server. The example uses port 3001
so the local products service can use port 3000.

The development command loads `.env` directly through Node.js. Production
configuration must be supplied through environment variables; `npm start`
does not load `.env`.

## Commands

- `npm run build`: compile `src` into `dist`.
- `npm start`: run the compiled server after building.
- `npm run lint`: check source files with Biome; formatting is disabled.
- `npm test`: run TypeScript tests with `node:test` through `tsx`.
- `npm run test:local`: run those tests with local `.env` configuration.

Products integration tests use synthetic products and ephemeral local HTTP
servers, without a database or production API calls.

## Products integration

`loadOrderProducts(items, productsServiceUrl)` in `src/products.ts` reads
`GET /products/:id` and returns product snapshots with the catalog's `shortName`,
requested quantity, and price in cents using `Math.round(price * 100)`.
It checks the product ID, nonblank name, finite nonnegative price, and
nonnegative integer stock, then rejects quantities above available stock.
Prices with fractional cents are rounded rather than rejected; there is no
EUR 100,000 unit-price cap, but cent values must remain safe integers.
All lookups share a five-second deadline, including response bodies.

Failures throw ordinary `Error` objects with clear messages for missing
products, insufficient stock, unavailable services, or invalid responses.
There are no custom error classes, status codes, or stock-detail fields.
Error messages do not include upstream response bodies or connection details.
Underlying network and parsing errors are retained as causes for diagnostics,
not for returning to API clients.

The caller supplies `PRODUCTS_SERVICE_URL`. HTTP error handling
and order persistence are separate pending
steps; this module does not reserve or reduce stock.

## Request validation

`validateOrderRequest(body)` in `src/validation.ts` validates an unknown request
body and returns a new, trimmed order request. The demo accepts only these fields:

```json
{
  "customer": {
    "name": "Demo Buyer",
    "email": "buyer@example.com",
    "phone": "+381601234567"
  },
  "shippingAddress": {
    "address": "Demo Street 1",
    "zipCode": "11000",
    "city": "Belgrade",
    "country": "Serbia"
  },
  "paymentMethod": "cash",
  "items": [{ "id": "test-product", "quantity": 2 }]
}
```

All text is required and trimmed. Maximum lengths are 100 for name, city,
country, and product ID; 254 for email; 32 for phone; 200 for address; and 20 for
ZIP code. Email and phone patterns match the existing frontend checkout.
Orders contain 1–50 distinct product IDs, with integer quantities from 1–99.
Only cash payment is supported. Unknown fields, including client prices,
stock, and `expectedTotalCents`, are rejected with ordinary errors that do not
include customer values. Idempotency keys and price-change confirmation are
outside the simplified demo scope.

The function does not call services or access a database. Stock availability
is checked later by the products integration; request body size limits and HTTP
400 responses will be handled when the route is added.

## Order totals

`calculateOrderTotals(products)` in `src/totals.ts` receives product snapshots
and returns `items` with `lineTotalCents` and a `totals` object, all in cents.
It multiplies unit prices by quantities, sums the lines, and adds EUR 10 shipping.
Product prices already include 20% VAT: the net subtotal is the gross subtotal
divided by 1.20, rounded to the nearest cent with halves rounded upward.
VAT is the difference between gross and net; it is not added again or applied
to shipping. Integer arithmetic keeps rounding exact.

For EUR 99.99 of products, net is EUR 83.33, VAT is EUR 16.66, and the final
total is EUR 109.99. Empty orders, invalid prices or quantities, and amounts
outside JavaScript's safe integer range throw ordinary errors.
The function does not modify its input, call services, or access a database.
It is not connected to an HTTP route yet.

## Configuration

- `PORT`: HTTP port, defaulting to 3001.
- `DATABASE_URL`: PostgreSQL connection string; database access is not wired yet.
- `PRODUCTS_SERVICE_URL`: products API base URL; the integration module is ready,
  but no endpoint calls it yet.
- `CORS_ORIGIN`: allowed frontend origin; CORS is not implemented yet.
- `APP_VERSION`: deployment version; the version route is not implemented yet.

Never commit real credentials. The skeleton does not connect to a database,
call the products service, or expose any API endpoints; requests currently
receive Express's default 404 response.

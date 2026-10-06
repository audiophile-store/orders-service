# orders-service

Orders microservice for the Audiophile store. The project currently contains
the application skeleton, request validation, products API integration, and order
totals calculation, an orders database migration, and order persistence.
`POST /orders` connects these modules and uses the configured database pool.

## Requirements

- Node.js 22.12 or newer
- npm
- Docker with Docker Compose for the local databases

## Local development

Run `npm install`, then create a local `.env` based on `.env.example`.
Start the database and apply the migration as described below, then run
`npm run dev` to start the development server. The example uses port 3001
so the local products service can use port 3000. The products service must be
available at `PRODUCTS_SERVICE_URL` to create an order.

The development command loads `.env` directly through Node.js. Production
configuration must be supplied through environment variables; `npm start`
does not load `.env`.

## Commands

- `npm run build`: compile `src` into `dist`.
- `npm start`: run the compiled server after building.
- `npm run lint`: check source files with Biome; formatting is disabled.
- `npm test`: run TypeScript tests with `node:test` through `tsx`; schema tests
  require `TEST_DATABASE_URL`.
- `npm run test:local`: run those tests with local `.env` configuration,
  including `TEST_DATABASE_URL`.

Products integration tests use synthetic products and ephemeral local HTTP
servers, without a database or production API calls. Endpoint tests use the
isolated test database and temporary local servers for the orders and synthetic
products APIs; they do not call the real products service.

## Continuous integration

[GitHub Actions](.github/workflows/ci.yml) runs on pull requests targeting `main`
and pushes to `main`. The workflow uses Node.js 22 and an isolated PostgreSQL 16
service with an `orders_test` database. It runs `npm ci`, lint, build, and tests.

Database and endpoint tests apply migrations in isolated schemas and roll back
their changes. CI does not require a local `.env` file or a running products
service.

## Database and migration

### Persistent local databases

`compose.yaml` defines PostgreSQL 16 with a named `orders_data` volume.
On the first startup, PostgreSQL creates the development database `orders`;
`docker/init-test-db.sql` creates a separate `orders_test` database in the
same instance. Port 5433 is bound to localhost so the products database can
continue using port 5432. Compose currently runs only PostgreSQL, not the app.

In your local `.env`, set `POSTGRES_PASSWORD` and replace `YOUR_LOCAL_PASSWORD`
in both database URLs with the same password. URL-encode special characters in
the URLs. Do not commit `.env` or share the password. A missing password makes
Compose fail explicitly.

The following commands are manual steps; adding the configuration does not
start a container or apply the orders migration.

Start the database:

```sh
docker compose up -d db
```

Check its status and list the databases:

```sh
docker compose ps
docker compose exec db psql -U orders -d orders -c '\l'
```

Apply the orders migration to the development database:

```sh
docker compose exec -T db psql -U orders -d orders -v ON_ERROR_STOP=1 < migrations/001_create_orders.sql
```

Inspect the table:

```sh
docker compose exec db psql -U orders -d orders -c '\d orders'
```

Run tests with the test database URL from `.env`:

```sh
npm run test:local
```

The named volume preserves both databases after container restarts or
`docker compose down`. Do not remove the volume if you want to keep the data.
The initialization script runs only on an empty volume; it does not rerun or
apply table migrations on later startups. Changing the password in `.env`
does not change a password already stored in the database.

### Orders schema

The demo uses one `orders` table. Customer details, shipping address, payment,
currency, timestamps, and totals are columns; `items` is a JSONB array containing
product snapshots and line totals. There is no separate order-items table or
idempotency storage. The application will provide a UUID; PostgreSQL defaults
`created_at` to the insertion time.

Apply `migrations/001_create_orders.sql` manually to a new orders database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_create_orders.sql
```

The migration never runs on application startup. Applying it again fails rather
than replacing an existing table. It requires all order fields, nonblank customer
and address text, cash payment, EUR currency, and a nonempty JSON array of items.
Amounts use BIGINT cents within JavaScript's safe integer range; net plus VAT
must equal the subtotal, and subtotal plus shipping must equal the total.
`pg` returns BIGINT values as strings; future persistence code must convert
validated amounts back to numbers for API responses.

Detailed item validation remains in the backend, not in SQL constraints.
Keeping snapshots in the order row makes saving a whole order a single atomic
insert. Do not put real customer data into test fixtures.

Create a separate database named `orders_test`, then set `TEST_DATABASE_URL`
to its PostgreSQL URL. Schema tests refuse other database names, apply the
migration in a unique test schema inside a transaction, and roll back all
test data and schema changes. They do not require a pre-applied migration
and do not read `DATABASE_URL`. The test user needs permission to create schemas.
Tests fail explicitly when test configuration is missing; they are not skipped.

### Saving an order

`src/db.ts` exports a PostgreSQL `pool` configured with `DATABASE_URL`.
Importing it requires that variable but does not open a connection until a query
is made. Idle connection failures are logged without exposing connection details.
The server passes the pool to `createApp` for order requests.

`saveOrder(database, order, calculation)` in `src/orders.ts` receives the pool
(or a test client), a validated request, and the server's totals calculation.
It generates a UUID and saves all customer, shipping, payment, total, and JSONB
item data with one parameterized `INSERT`. It returns `orderId` and `createdAt`
as an ISO timestamp. A single insert is atomic, so no explicit transaction is
needed; database failures propagate to the caller instead of returning success.
It does not fetch products, change inputs, or implement retries/idempotency.

Persistence tests reuse the schema tests' isolated `orders_test` transaction
and roll back all saved orders. Pool tests use the test URL in child processes
without opening database connections. Neither uses the development database.

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

The server supplies `PRODUCTS_SERVICE_URL` to the endpoint. This module does
not reserve or reduce stock.

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

The function does not call services or access a database. The endpoint checks
stock later through the products integration, limits JSON bodies to 32 KB,
and returns HTTP 400 for invalid requests.

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
The endpoint uses this result for storage and its response.

## HTTP API

`POST /orders` requires `Content-Type: application/json` and the request shown
above. The flow is validation, products lookup, totals calculation, and one
atomic order insert. No successful response is sent before the insert completes.
Success returns HTTP 201 with this shape:

```json
{
  "orderId": "7b62b419-4a9b-42f5-a4ce-30dc59f92dd9",
  "createdAt": "2026-10-06T00:00:00.000Z",
  "currency": "EUR",
  "paymentMethod": "cash",
  "items": [
    {
      "id": "test-product",
      "name": "Test headphones",
      "quantity": 2,
      "unitPriceCents": 6000,
      "lineTotalCents": 12000
    }
  ],
  "totals": {
    "subtotalCents": 12000,
    "netSubtotalCents": 10000,
    "vatCents": 2000,
    "shippingCents": 1000,
    "totalCents": 13000
  }
}
```

Examples use synthetic products, not IDs from the real catalog. Errors return
JSON with an `error` message: 400 for invalid requests/JSON or unsafe calculated
amounts, 413 for bodies above 32 KB, 422 for unknown products, 409 for insufficient
stock, 503 for unavailable or invalid products responses, and 500 for unexpected
or database failures. Failures do not save an order. Responses and unexpected
error logs do not expose customer data, upstream bodies, or connection details.
Other routes still return 404.

This demo does not provide authentication, payment processing, stock
reservation, or idempotency; resubmitting a successful order creates another
order. CORS and frontend integration, health/readiness, and version routes
remain pending.

## Configuration

- `PORT`: HTTP port, defaulting to 3001.
- `POSTGRES_PASSWORD`: local PostgreSQL password used by Compose on first startup.
- `DATABASE_URL`: required PostgreSQL connection string for the application pool.
- `TEST_DATABASE_URL`: separate PostgreSQL connection string for `orders_test`;
  used only by database and endpoint tests.
- `PRODUCTS_SERVICE_URL`: required products API base URL.
- `CORS_ORIGIN`: allowed frontend origin; CORS is not implemented yet.
- `APP_VERSION`: deployment version; the version route is not implemented yet.

Never commit real credentials. Configuration is required at startup; product
and database connections are used when an order request is processed.

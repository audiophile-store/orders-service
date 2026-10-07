# orders-service

Orders microservice for the Audiophile store. The project currently contains
the application skeleton, request validation, products API integration, and order
totals calculation, an orders database migration, and order persistence.
`POST /orders` connects these modules and uses the configured database pool.

## Requirements

- Node.js 22.12 or newer and npm for development outside Docker
- Docker with Docker Compose for the local databases and containerized application

## Local development

Run `npm install`, then create a local `.env` based on `.env.example`.
Start the database and apply the migration as described below, then run
`npm run dev` to start the development server. The example uses port 3001
so the local products service can use port 3000. The products service must be
available at `PRODUCTS_SERVICE_URL` to create an order.

The development command loads `.env` directly through Node.js. Production
configuration must be supplied through environment variables; `npm start`
does not load `.env`.

## Running the application with Docker

The multi-stage `Dockerfile` compiles TypeScript in a build stage. The runtime
stage contains the compiled application and production dependencies and runs
Node.js as the non-root `node` user. `.dockerignore` excludes local dependencies,
build output, Git metadata, and `.env` files from the build context.

Create a local `.env` from `.env.example` and configure:

- `POSTGRES_PASSWORD`: the local PostgreSQL password.
- `DOCKER_DATABASE_URL`: `postgresql://orders:YOUR_LOCAL_PASSWORD@db:5432/orders`,
  replacing the placeholder with the URL-encoded database password.
- `DOCKER_PRODUCTS_SERVICE_URL`: the products API address reachable from the
  container. On Docker Desktop, `http://host.docker.internal:3000` reaches a
  products service running on the host or publishing port 3000 from another
  container. On other Docker setups, configure an appropriate reachable address.
- `APP_VERSION`: the deployment version returned by `/version`, defaulting to
  `0.1.0`.

Compose passes the Docker URLs to the application as `DATABASE_URL` and
`PRODUCTS_SERVICE_URL`. The existing host URLs remain available for development
through npm. Compose reads `.env` for interpolation; it does not copy it into
the image. Never commit the real credentials.

Validate configuration without printing resolved credentials, then build and
start the application and database:

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail=30 app
```

The application is available at `http://localhost:3001`. Compose waits for the
database healthcheck before starting it, but does not apply orders migrations.
For a fresh database, apply the migration using the command in the database
section below. Do not reapply it to an existing orders table.

The products service must be started separately and have products available
before creating an order. This Compose project runs only the orders application
and its database. `GET /` returns 404 because there is no root route.
The image healthcheck calls `/health` using Node.js every ten seconds, with a
three-second request deadline, a five-second startup grace period, and three
consecutive failures before Docker marks the container unhealthy. It does not
check readiness or automatically restart unhealthy containers.

Check the operational endpoints:

```sh
curl -i http://localhost:3001/health
curl -i http://localhost:3001/ready
curl -i http://localhost:3001/version
```

To build only the application image without starting containers:

```sh
docker build -t audiophile-orders:local .
```

To stop the Compose project:

```sh
docker compose down
```

The database volume is retained. Do not add `-v` if you want to preserve data.

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
service with an `orders_test` database. It runs `npm ci`, lint, build, and tests,
then checks the Docker image build with `docker build --pull`. The Docker step
checks image construction only; it does not start the application, publish the
image, or deploy it.

Database and endpoint tests apply migrations in isolated schemas and roll back
their changes. CI does not require a local `.env` file or a running products
service.

## Database and migration

### Persistent local databases

`compose.yaml` defines PostgreSQL 16 with a named `orders_data` volume.
On the first startup, PostgreSQL creates the development database `orders`;
`docker/init-test-db.sql` creates a separate `orders_test` database in the
same instance. Port 5433 is bound to localhost so the products database can
continue using port 5432. Compose also defines the orders application; use
`docker compose up -d db` to start only the database for development through npm.

In your local `.env`, set `POSTGRES_PASSWORD` and replace `YOUR_LOCAL_PASSWORD`
in `DATABASE_URL`, `TEST_DATABASE_URL`, and `DOCKER_DATABASE_URL` with the same
password. URL-encode special characters in the URLs, not in `POSTGRES_PASSWORD`.
Also configure `DOCKER_PRODUCTS_SERVICE_URL`. Compose validates these required
Docker variables even when starting only the database. Do not commit `.env` or
share the password. Missing required values make Compose fail explicitly.

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
is made. Connection establishment and waiting for an available pool connection
have a two-second deadline, including order requests. Idle connection failures
are logged without exposing connection details.
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

## Operational endpoints

These endpoints return JSON with `Cache-Control: no-store`:

| Route | Success response | Purpose |
| --- | --- | --- |
| `GET /health` | `200`, `{ "status": "ok" }` | HTTP application liveness, independent of the database and products service |
| `GET /ready` | `200`, `{ "status": "ready" }` | Database connectivity and availability of all columns used by order persistence |
| `GET /version` | `200`, `{ "version": "0.1.0" }` | Configured deployment version |

Readiness resolves the orders columns with a `SELECT ... WHERE FALSE`, without
reading customer rows or changing data. It has a two-second query deadline,
in addition to the pool's two-second connection deadline. Database failures,
missing tables or columns, and timeouts return `503` with
`{ "status": "not_ready" }` and log a generic message without internal details.
The check does not validate every schema constraint, reserve stock, or contact
the products service, so success is not a guarantee that a particular order will
succeed.

The server trims `APP_VERSION` and defaults to `0.1.0` when it is absent or blank.
Compose forwards this setting to the container. Tests cover dependency-free
liveness/version, readiness success and missing schema, unavailable databases,
query deadlines, and exhausted connection pools using the isolated test database.

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
order. Frontend checkout integration remains pending.

## CORS

Set `CORS_ORIGIN` to one exact HTTP(S) frontend origin, such as
`http://localhost:5173`, without a trailing slash, path, query, fragment, or
credentials. Whitespace around the setting is trimmed. Invalid nonempty
configuration fails at startup. Compose forwards this setting to the container.

Matching browser origins receive `Access-Control-Allow-Origin` on successful
and error responses, with `Vary: Origin` for cache correctness. Other origins
receive no allow-origin header. Missing or blank configuration disables
cross-origin browser access. No wildcard or credentialed CORS is enabled.

`OPTIONS /orders` preflight requests permit `POST` with `Content-Type` and
return 204 without accessing the database or products service. Disallowed
origins, methods, or requested headers return 403 with a generic JSON error and
a safe log message. Ordinary OPTIONS requests without preflight headers retain
Express's default behavior.

CORS is a browser policy, not authentication or authorization. It does not
prevent non-browser clients from calling the API or guarantee that an actual
request from a disallowed origin cannot reach order processing.

Check preflight locally:

```sh
curl -i -X OPTIONS http://localhost:3001/orders \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type'
```

## Configuration

- `PORT`: HTTP port, defaulting to 3001.
- `POSTGRES_PASSWORD`: local PostgreSQL password used by Compose on first startup.
- `DATABASE_URL`: required PostgreSQL connection string for the application pool.
- `TEST_DATABASE_URL`: separate PostgreSQL connection string for `orders_test`;
  used only by database and endpoint tests.
- `PRODUCTS_SERVICE_URL`: required products API base URL.
- `DOCKER_DATABASE_URL`: required Compose input passed to the application as
  `DATABASE_URL`; use `db:5432` for the database in the Compose network.
- `DOCKER_PRODUCTS_SERVICE_URL`: required Compose input passed to the application
  as `PRODUCTS_SERVICE_URL`; use an address reachable from the orders container.
- `CORS_ORIGIN`: one allowed HTTP(S) frontend origin; blank or missing disables
  cross-origin browser access.
- `APP_VERSION`: deployment version returned by `/version`, defaulting to `0.1.0`.

Never commit real credentials. Configuration is required at startup; product
and database connections are used when an order request is processed.

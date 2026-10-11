# Audiophile Orders Service

The checkout backend for the Audiophile portfolio project. It validates an order,
loads current prices and stock from the products service, calculates totals and
saves the order in PostgreSQL before returning confirmation.

**[Live webshop](https://audiophile-store-beryl.vercel.app/)** ·
**[Frontend code and screenshots](https://github.com/audiophile-store/webshop)**

**Admin demo access:** Contact [Stefan Rakonjac](https://github.com/xarambash)
for private credentials to explore the webshop's admin area.

## Highlights

- Cash checkout with server-side validation, prices and stock checks.
- EUR totals in integer cents, with 20% VAT included in product prices and EUR 10 shipping.
- Atomic order persistence with product snapshots and a server-generated order ID.
- Configurable CORS and JSON preflight support.
- Separate process liveness and database readiness endpoints.
- Unit, database and API integration tests with GitHub Actions checks.

**Tech stack:** TypeScript, Node.js, Express, PostgreSQL, Docker and Biome.
The backend is hosted on Render.

**Demo scope:** No real payment, authentication, stock reservation or idempotency.
A repeated successful submission creates another order. The webshop uses this
API for checkout; an order-history API is not available.

## API overview

| Endpoint       | Purpose                                                |
| -------------- | ------------------------------------------------------ |
| `POST /orders` | Save an order; HTTP 201 with item snapshots and totals |
| `GET /health`  | Process liveness                                       |
| `GET /ready`   | Database connectivity and required order columns       |
| `GET /version` | Deployment version                                     |

Checkout sends customer details, a shipping address, `paymentMethod: "cash"`
and product IDs/quantities. Client-supplied prices or totals are rejected.
Confirmation includes `orderId`, `createdAt`, items and totals in EUR cents.
Invalid requests, unknown products, insufficient stock and unavailable dependencies
return explicit errors.

## Run locally

Use Node.js 22.12+ and Docker Compose. Copy `.env.example` to `.env` and configure
the database password and URLs. Start the products service separately at
`http://localhost:3000` with a populated catalogue.

For a fresh orders database:

```bash
npm install
docker compose up -d db
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' < migrations/001_create_orders.sql
npm run dev
```

The API runs at `http://localhost:3001`. Apply the migration only once.
After database setup, use `docker compose up --build -d` as an alternative
to the development server.

| Variable                      | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`                | PostgreSQL URL for commands on the host                |
| `PRODUCTS_SERVICE_URL`        | Products API base URL; locally `http://localhost:3000` |
| `CORS_ORIGIN`                 | Exact frontend origin; locally `http://localhost:5173` |
| `DOCKER_DATABASE_URL`         | Database URL using the Compose hostname `db`           |
| `DOCKER_PRODUCTS_SERVICE_URL` | Products URL reachable from the container              |
| `PORT`                        | HTTP port, default `3001`                              |

Compose requires `POSTGRES_PASSWORD` and both Docker URLs even for database-only
commands. On Docker Desktop, `http://host.docker.internal:3000` reaches a products
service publishing port 3000 on the host. Do not commit credentials.
On Render, use production `DATABASE_URL`, HTTPS `PRODUCTS_SERVICE_URL` and the
exact HTTPS webshop `CORS_ORIGIN`, without a trailing slash.

## Quality checks

`npm run lint`, `npm run build` and `npm run test:local`.
Database tests require a separate `orders_test` database via `TEST_DATABASE_URL`;
tests apply migrations in isolated schemas and roll back changes.
Fresh Compose database initialization creates `orders_test` automatically.
CI runs lint, build, tests and a Docker build without deploying.
Changes to `main` require a PR, successful `checks` and an up-to-date branch.

## Related services

[Products](https://github.com/audiophile-store/products-service) ·
[Authentication](https://github.com/audiophile-store/auth-service)

## Author

Stefan Rakonjac — [@xarambash](https://github.com/xarambash)

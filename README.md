# orders-service

Orders microservice for the Audiophile store. The project currently contains
the application skeleton and a tested products API integration module; API
routes and database access are not implemented yet.

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

The caller supplies `PRODUCTS_SERVICE_URL`. Request validation, totals
calculation, HTTP error handling, and order persistence are separate pending
steps; this module does not reserve or reduce stock.

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

# orders-service

Orders microservice for the Audiophile store. The project currently contains
the application skeleton only; API routes, database access, and tests are not
implemented yet.

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
- `npm test`: run future TypeScript tests with `node:test` through `tsx`.
- `npm run test:local`: run those tests with local `.env` configuration.

Test commands are prepared for the next step; there are no test files yet.

## Configuration

- `PORT`: HTTP port, defaulting to 3001.
- `DATABASE_URL`: PostgreSQL connection string; database access is not wired yet.
- `PRODUCTS_SERVICE_URL`: products API base URL; integration is not wired yet.
- `CORS_ORIGIN`: allowed frontend origin; CORS is not implemented yet.
- `APP_VERSION`: deployment version; the version route is not implemented yet.

Never commit real credentials. The skeleton does not connect to a database,
call the products service, or expose any API endpoints; requests currently
receive Express's default 404 response.

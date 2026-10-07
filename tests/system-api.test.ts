import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { Pool } from "pg";
import type { Client } from "pg";
import { createApp } from "../src/app.js";
import { openTestDatabase, withTestRollback } from "./test-database.js";

async function withApp(
  database: Client | Pool,
  run: (url: string) => Promise<void>,
  version?: string,
) {
  const server = createServer(createApp(database, "http://127.0.0.1:1", version));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function assertResponse(
  url: string,
  status: number,
  body: { status: string } | { version: string },
) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), body);
}

test("health and version do not connect to the database or products service", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  try {
    await withApp(database, async (url) => {
      await assertResponse(`${url}/health`, 200, { status: "ok" });
      await assertResponse(`${url}/version`, 200, { version: "0.1.0" });
      assert.equal(database.totalCount, 0);
    });
    await withApp(database, async (url) => {
      await assertResponse(`${url}/version`, 200, { version: "test-release" });
    }, "test-release");
  } finally {
    await database.end();
  }
});

test("readiness returns 503 for an unavailable database without exposing details", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const database = new Pool({
    host: "127.0.0.1",
    port: 1,
    connectionTimeoutMillis: 2000,
  });
  try {
    await withApp(database, async (url) => {
      await assertResponse(`${url}/ready`, 503, { status: "not_ready" });
      await assertResponse(`${url}/health`, 200, { status: "ok" });
    });
    assert.equal(log.mock.callCount(), 1);
    assert.deepEqual(log.mock.calls[0]?.arguments, ["Database readiness check failed"]);
  } finally {
    await database.end();
  }
});

test("readiness checks the orders columns without reading or changing rows", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const database = await openTestDatabase();
  try {
    await withApp(database, async (url) => {
      await assertResponse(`${url}/ready`, 200, { status: "ready" });
      const result = await database.query<{ count: string }>("SELECT count(*) FROM orders");
      assert.equal(result.rows[0]?.count, "0");

      await withTestRollback(database, async () => {
        await database.query("ALTER TABLE orders RENAME TO unavailable_orders");
        await assertResponse(`${url}/ready`, 503, { status: "not_ready" });
      });
      await withTestRollback(database, async () => {
        await database.query("ALTER TABLE orders DROP COLUMN customer_phone");
        await assertResponse(`${url}/ready`, 503, { status: "not_ready" });
      });
      await assertResponse(`${url}/ready`, 200, { status: "ready" });
    });
    assert.equal(log.mock.callCount(), 2);
    for (const call of log.mock.calls) {
      assert.deepEqual(call.arguments, ["Database readiness check failed"]);
    }
  } finally {
    await database.query("ROLLBACK");
    await database.end();
  }
});

test("readiness has a two-second query deadline even when another query is running", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const database = await openTestDatabase();
  try {
    await withApp(database, async (url) => {
      const slowQuery = database.query("SELECT pg_sleep(3)");
      const start = performance.now();
      try {
        await assertResponse(`${url}/ready`, 503, { status: "not_ready" });
        const elapsed = performance.now() - start;
        assert.ok(elapsed >= 1800 && elapsed < 2800, `Readiness took ${elapsed} ms`);
      } finally {
        await slowQuery;
      }
      await assertResponse(`${url}/ready`, 200, { status: "ready" });
    });
    assert.equal(log.mock.callCount(), 1);
  } finally {
    await database.query("ROLLBACK");
    await database.end();
  }
});

test("readiness has a two-second deadline when the connection pool is exhausted", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  assert.ok(process.env.TEST_DATABASE_URL, "Set TEST_DATABASE_URL for readiness tests");
  const database = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  const heldClient = await database.connect();
  try {
    await withApp(database, async (url) => {
      const start = performance.now();
      await assertResponse(`${url}/ready`, 503, { status: "not_ready" });
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 1800 && elapsed < 5000, `Readiness took ${elapsed} ms`);
      assert.equal(database.waitingCount, 0);
      await assertResponse(`${url}/health`, 200, { status: "ok" });
    });
    assert.equal(log.mock.callCount(), 1);
  } finally {
    heldClient.release();
    await database.end();
  }
});

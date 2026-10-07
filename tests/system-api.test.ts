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
  corsOrigin?: string,
) {
  const server = createServer(createApp(database, "http://127.0.0.1:1", version, corsOrigin));
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

test("CORS exposes responses only to the configured exact origin", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  const origin = "http://localhost:5173";
  try {
    await withApp(database, async (url) => {
      for (const requestedOrigin of [origin, `${origin}.evil.example`, "http://localhost:5174", "null", ""]) {
        const response = await fetch(`${url}/health`, {
          headers: requestedOrigin ? { Origin: requestedOrigin } : {},
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), requestedOrigin === origin ? origin : null);
        assert.match(response.headers.get("vary") ?? "", /Origin/i);
        assert.equal(response.headers.get("access-control-allow-credentials"), null);
        await response.json();
      }
      assert.equal(database.totalCount, 0);
    }, undefined, ` ${origin} `);

    for (const configuredOrigin of [undefined, "", "   "]) {
      await withApp(database, async (url) => {
        const response = await fetch(`${url}/health`, { headers: { Origin: origin } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        await response.json();
      }, undefined, configuredOrigin);
    }
  } finally {
    await database.end();
  }
});

test("CORS allows JSON order preflight without accessing the database or products", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  const origin = "http://localhost:5173";
  try {
    await withApp(database, async (url) => {
      for (const path of ["/orders", "/orders/"]) {
        for (const requestedHeaders of ["Content-Type", "content-type", " CONTENT-TYPE ", undefined]) {
          const headers: Record<string, string> = {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
          };
          if (requestedHeaders) headers["Access-Control-Request-Headers"] = requestedHeaders;
          const response = await fetch(`${url}${path}`, { method: "OPTIONS", headers });
          assert.equal(response.status, 204);
          assert.equal(await response.text(), "");
          assert.equal(response.headers.get("access-control-allow-origin"), origin);
          assert.equal(response.headers.get("access-control-allow-methods"), "POST");
          assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
          assert.equal(response.headers.get("access-control-allow-credentials"), null);
          for (const field of ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]) {
            assert.ok(response.headers.get("vary")?.includes(field));
          }
        }
      }
      assert.equal(database.totalCount, 0);
    }, undefined, origin);
  } finally {
    await database.end();
  }
});

test("CORS rejects disallowed order preflights with a safe explicit error", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  const origin = "http://localhost:5173";
  const cases = [
    { configured: origin, requested: "https://untrusted.example", method: "POST", headers: "Content-Type" },
    { configured: undefined, requested: origin, method: "POST", headers: "Content-Type" },
    { configured: origin, requested: origin, method: "DELETE", headers: "Content-Type" },
    { configured: origin, requested: origin, method: "POST", headers: "Content-Type, X-Custom" },
  ];
  try {
    for (const entry of cases) {
      await withApp(database, async (url) => {
        const response = await fetch(`${url}/orders`, {
          method: "OPTIONS",
          headers: {
            Origin: entry.requested,
            "Access-Control-Request-Method": entry.method,
            "Access-Control-Request-Headers": entry.headers,
          },
        });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: "CORS preflight rejected" });
        assert.equal(response.headers.get("access-control-allow-methods"), null);
        if (entry.requested !== entry.configured) {
          assert.equal(response.headers.get("access-control-allow-origin"), null);
        }
        assert.equal(database.totalCount, 0);
      }, undefined, entry.configured);
    }
    assert.equal(log.mock.callCount(), cases.length);
    for (const call of log.mock.calls) {
      assert.deepEqual(call.arguments, ["Order CORS preflight rejected"]);
    }
  } finally {
    await database.end();
  }
});

test("CORS headers remain present on validation, parsing, and body-limit errors", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  const origin = "http://localhost:5173";
  try {
    await withApp(database, async (url) => {
      for (const [body, status] of [["{}", 400], ["{broken", 400], [" ".repeat(32769), 413]] as const) {
        const response = await fetch(`${url}/orders`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body,
        });
        assert.equal(response.status, status);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        await response.json();
      }
      const response = await fetch(`${url}/orders`, {
        method: "POST",
        headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      await response.json();
      assert.equal(database.totalCount, 0);
    }, undefined, origin);
  } finally {
    await database.end();
  }
});

test("ordinary OPTIONS and unrelated routes preserve their existing behavior", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  try {
    await withApp(database, async (url) => {
      const response = await fetch(`${url}/orders`, { method: "OPTIONS" });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("allow") ?? "", /POST/);
      await response.text();
      const missing = await fetch(`${url}/missing`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
      });
      assert.equal(missing.status, 404);
      await missing.text();
    }, undefined, "http://localhost:5173");
  } finally {
    await database.end();
  }
});

test("CORS fails explicitly for origins containing wildcards, paths, or credentials", async () => {
  const database = new Pool({ host: "127.0.0.1", port: 1 });
  try {
    for (const origin of [
      "*", "null", "invalid", "ftp://example.com", "https://example.com/",
      "https://example.com/path", "https://example.com?query=1",
      "https://user:private@example.com", "https://example.com#fragment",
    ]) {
      assert.throws(
        () => createApp(database, "http://127.0.0.1:1", undefined, origin),
        { message: "CORS_ORIGIN must be an HTTP(S) origin without a path or credentials" },
      );
    }
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

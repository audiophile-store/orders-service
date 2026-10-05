import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { createApp } from "../src/app.js";
import { openTestDatabase, withTestRollback } from "./test-database.js";

let client: Client;
let apiServer: Server;
let apiUrl: string;
let mode = "normal";
let requests: string[] = [];
let products = new Map<string, unknown>();

const productsServer = createServer((request, response) => {
  requests.push(request.url ?? "");
  if (mode === "timeout") return;
  if (mode === "disconnect") {
    request.socket.destroy();
    return;
  }
  if (mode === "unavailable") {
    response.writeHead(503);
    response.end("private upstream details");
    return;
  }
  if (mode === "invalid-json") {
    response.end("{broken-json");
    return;
  }
  const product = products.get(request.url ?? "");
  response.writeHead(product === undefined ? 404 : 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(product ?? { error: "Product not found" }));
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

before(async () => {
  client = await openTestDatabase();
  const productsUrl = await listen(productsServer);
  apiServer = createServer(createApp(client, productsUrl));
  apiUrl = await listen(apiServer);
});

after(async () => {
  try {
    await close(apiServer);
    await close(productsServer);
  } finally {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  }
});

function request() {
  return {
    customer: { name: "Demo Buyer", email: "buyer@example.com", phone: "+381601234567" },
    shippingAddress: { address: "Demo Street 1", zipCode: "11000", city: "Belgrade", country: "Serbia" },
    paymentMethod: "cash",
    items: [{ id: "test-product", quantity: 2 }],
  };
}

function withOrder(run: () => Promise<void>) {
  mode = "normal";
  requests = [];
  products = new Map([
    ["/products/test-product", { id: "test-product", shortName: "Test headphones", price: 60, inStock: 5 }],
  ]);
  return withTestRollback(client, run);
}

function post(body = JSON.stringify(request())) {
  return fetch(`${apiUrl}/orders`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
}

async function assertNoOrders() {
  const result = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM orders");
  assert.equal(result.rows[0]?.count, 0);
}

test("POST /orders returns 201 and stores the complete server-priced order", async () => {
  await withOrder(async () => {
    const response = await post();
    assert.equal(response.status, 201);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = await response.json();
    assert.match(body.orderId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(new Date(body.createdAt).toISOString(), body.createdAt);
    assert.deepEqual(body, {
      orderId: body.orderId, createdAt: body.createdAt, currency: "EUR", paymentMethod: "cash",
      items: [{ id: "test-product", name: "Test headphones", quantity: 2, unitPriceCents: 6000, lineTotalCents: 12000 }],
      totals: { subtotalCents: 12000, netSubtotalCents: 10000, vatCents: 2000, shippingCents: 1000, totalCents: 13000 },
    });
    const saved = await client.query<Record<string, unknown>>("SELECT * FROM orders");
    assert.equal(saved.rows.length, 1);
    const row = saved.rows[0];
    assert.ok(row);
    assert.equal(row.id, body.orderId);
    assert.equal(row.customer_email, request().customer.email);
    assert.equal(row.shipping_address, request().shippingAddress.address);
    assert.deepEqual(row.items, body.items);
    assert.equal(row.total_cents, String(body.totals.totalCents));
    assert.deepEqual(requests, ["/products/test-product"]);
  });
});

test("POST /orders prices multiple products and rounds VAT at order level", async () => {
  await withOrder(async () => {
    products.set("/products/other-product", { id: "other-product", shortName: "Other headphones", price: 99.99, inStock: 1 });
    const response = await post(JSON.stringify({
      ...request(), items: [...request().items, { id: "other-product", quantity: 1 }],
    }));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.totals, {
      subtotalCents: 21999, netSubtotalCents: 18333, vatCents: 3666, shippingCents: 1000, totalCents: 22999,
    });
  });
});

const invalidRequests = [
  { ...request(), customer: { ...request().customer, name: " " } },
  { ...request(), items: [] },
  { ...request(), paymentMethod: "card" },
  { ...request(), items: [{ id: "test-product", quantity: 2, price: 1 }] },
];
for (const [index, input] of invalidRequests.entries()) {
  test(`POST /orders rejects invalid input before products lookup (${index + 1})`, async () => {
    await withOrder(async () => {
      const response = await post(JSON.stringify(input));
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
      assert.deepEqual(requests, []);
      await assertNoOrders();
    });
  });
}

test("POST /orders returns a safe 400 for malformed JSON", async () => {
  await withOrder(async () => {
    const response = await post('{"private-customer-data":');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid JSON" });
    assert.deepEqual(requests, []);
    await assertNoOrders();
  });
});

for (const [bytes, status] of [[32768, 400], [32769, 413]]) {
  test(`POST /orders enforces the exact 32 KB body limit (${bytes} bytes)`, async () => {
    await withOrder(async () => {
      const base = JSON.stringify({ ...request(), padding: "" });
      const payload = JSON.stringify({ ...request(), padding: "x".repeat(bytes - base.length) });
      assert.equal(Buffer.byteLength(payload), bytes);
      const response = await post(payload);
      assert.equal(response.status, status);
      if (status === 413) assert.deepEqual(await response.json(), { error: "Request body too large" });
      assert.deepEqual(requests, []);
      await assertNoOrders();
    });
  });
}

test("POST /orders returns 422 for an unknown product without a partial order", async () => {
  await withOrder(async () => {
    const response = await post(JSON.stringify({
      ...request(), items: [...request().items, { id: "missing-product", quantity: 1 }],
    }));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "Product not found" });
    await assertNoOrders();
  });
});

test("POST /orders returns 409 for insufficient stock", async () => {
  await withOrder(async () => {
    products.set("/products/test-product", { id: "test-product", shortName: "Test headphones", price: 60, inStock: 1 });
    const response = await post();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Requested quantity exceeds available stock" });
    await assertNoOrders();
  });
});

for (const failure of ["unavailable", "disconnect", "invalid-json", "timeout"]) {
  test(`POST /orders returns 503 for products ${failure}`, { timeout: 8000 }, async () => {
    await withOrder(async () => {
      mode = failure;
      const response = await post();
      assert.equal(response.status, 503);
      const error = failure === "invalid-json"
        ? "Products service returned an invalid response" : "Products service is unavailable";
      assert.deepEqual(await response.json(), { error });
      await assertNoOrders();
    });
  });
}

test("POST /orders returns 503 for invalid product data", async () => {
  await withOrder(async () => {
    products.set("/products/test-product", { id: "test-product", price: null });
    const response = await post();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Products service returned an invalid response" });
    await assertNoOrders();
  });
});

test("POST /orders rejects an unsafe calculated amount before saving", async () => {
  await withOrder(async () => {
    products.set("/products/test-product", {
      id: "test-product", shortName: "Test headphones", price: Number.MAX_SAFE_INTEGER / 100, inStock: 5,
    });
    const response = await post();
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Order amount exceeds safe integer range" });
    await assertNoOrders();
  });
});

test("POST /orders returns a generic 500 when the database rejects the insert", async () => {
  await withOrder(async () => {
    await client.query("ALTER TABLE orders ADD CONSTRAINT private_database_details CHECK (FALSE)");
    const response = await post();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Could not create order" });
  });
  await assertNoOrders();
});

test("unrelated routes still return 404", async () => {
  const response = await fetch(`${apiUrl}/not-a-route`);
  assert.equal(response.status, 404);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { calculateOrderTotals } from "../src/totals.js";
import { validateOrderRequest } from "../src/validation.js";
import { openTestDatabase, withTestRollback } from "./test-database.js";

let client: Client;

before(async () => {
  client = await openTestDatabase();
});

after(async () => {
  if (client) {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

const example = {
  id: "7b62b419-4a9b-42f5-a4ce-30dc59f92dd9",
  customer_name: "Demo Buyer",
  customer_email: "buyer@example.com",
  customer_phone: "+381601234567",
  shipping_address: "Demo Street 1",
  shipping_zip_code: "11000",
  shipping_city: "Belgrade",
  shipping_country: "Serbia",
  payment_method: "cash",
  currency: "EUR",
  subtotal_cents: 12000,
  net_subtotal_cents: 10000,
  vat_cents: 2000,
  shipping_cents: 1000,
  total_cents: 13000,
  items: JSON.stringify([
    { id: "test-product", name: "Test headphones", quantity: 2, unitPriceCents: 6000, lineTotalCents: 12000 },
  ]),
};

async function insert(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { ...example, ...overrides };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  return client.query<Record<string, unknown>>(
    `INSERT INTO orders (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    Object.values(row),
  );
}

function withRollback(run: () => Promise<void>) {
  return withTestRollback(client, run);
}

test("stores an entire order with JSONB items and a generated creation time", async () => {
  await withRollback(async () => {
    const result = await insert();
    const row = result.rows[0];
    assert.ok(row);
    for (const [column, value] of Object.entries(example)) {
      const expected = column === "items" ? JSON.parse(example.items)
        : column.endsWith("_cents") ? String(value) : value;
      assert.deepEqual(row[column], expected);
    }
    assert.ok(row.created_at instanceof Date);
  });
});

test("rejects duplicate order IDs", async () => {
  await withRollback(async () => {
    await insert();
    await assert.rejects(() => insert(), { code: "23505", constraint: "orders_pkey" });
  });
});

for (const column of [...Object.keys(example), "created_at"]) {
  test(`requires ${column}`, async () => {
    await withRollback(async () => {
      await assert.rejects(() => insert({ [column]: null }), { code: "23502", column });
    });
  });
}

const textColumns = [
  "customer_name", "customer_email", "customer_phone", "shipping_address",
  "shipping_zip_code", "shipping_city", "shipping_country",
];
for (const column of textColumns) {
  test(`rejects blank ${column}`, async () => {
    await withRollback(async () => {
      await assert.rejects(() => insert({ [column]: "   " }), {
        code: "23514", constraint: `orders_${column}_check`,
      });
    });
  });
}

for (const column of Object.keys(example).filter((key) => key.endsWith("_cents"))) {
  for (const value of [-1, "9007199254740992"]) {
    test(`rejects out-of-range ${column} (${value})`, async () => {
      await withRollback(async () => {
        await assert.rejects(() => insert({ [column]: value }), { code: "23514" });
      });
    });
  }
}

const invalidOrders = [
  { name: "unsupported payment", values: { payment_method: "card" }, constraint: "orders_payment_method_check" },
  { name: "unsupported currency", values: { currency: "USD" }, constraint: "orders_currency_check" },
  { name: "empty items", values: { items: "[]" }, constraint: "orders_items_check" },
  { name: "object items", values: { items: "{}" }, constraint: "orders_items_check" },
  { name: "JSON null items", values: { items: "null" }, constraint: "orders_items_check" },
  { name: "inconsistent VAT sum", values: { net_subtotal_cents: 9999 }, constraint: "orders_subtotal_check" },
  { name: "inconsistent final total", values: { total_cents: 13001 }, constraint: "orders_total_check" },
];
for (const { name, values, constraint } of invalidOrders) {
  test(`rejects ${name}`, async () => {
    await withRollback(async () => {
      await assert.rejects(() => insert(values), { code: "23514", constraint });
    });
  });
}

type SaveOrder = (
  database: Client,
  order: ReturnType<typeof validateOrderRequest>,
  calculation: ReturnType<typeof calculateOrderTotals>,
) => Promise<{ orderId: string; createdAt: string }>;

async function loadSaveOrder(): Promise<SaveOrder> {
  const modulePath = "../src/orders.js";
  const { saveOrder } = await import(modulePath);
  assert.equal(typeof saveOrder, "function");
  return saveOrder;
}

function preparedOrder() {
  const order = validateOrderRequest({
    customer: { name: "Demo Buyer", email: "buyer@example.com", phone: "+381601234567" },
    shippingAddress: { address: "Demo Street 1", zipCode: "11000", city: "Belgrade", country: "Serbia" },
    paymentMethod: "cash",
    items: [{ id: "test-product", quantity: 2 }],
  });
  const calculation = calculateOrderTotals([
    { id: "test-product", name: "Test headphones", quantity: 2, unitPriceCents: 6000 },
  ]);
  return { order, calculation };
}

test("saveOrder stores all order fields and returns a UUID and ISO creation time", async () => {
  const saveOrder = await loadSaveOrder();
  await withRollback(async () => {
    const { order, calculation } = preparedOrder();
    const original = structuredClone({ order, calculation });
    const confirmation = await saveOrder(client, order, calculation);
    assert.deepEqual(Object.keys(confirmation).sort(), ["createdAt", "orderId"]);
    assert.match(confirmation.orderId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const result = await client.query<Record<string, unknown>>("SELECT * FROM orders WHERE id = $1", [confirmation.orderId]);
    const row = result.rows[0];
    assert.ok(row);
    for (const [column, value] of Object.entries(example)) {
      const expected = column === "id" ? confirmation.orderId
        : column === "items" ? calculation.items
        : column.endsWith("_cents") ? String(value) : value;
      assert.deepEqual(row[column], expected);
    }
    assert.ok(row.created_at instanceof Date);
    assert.equal(confirmation.createdAt, row.created_at.toISOString());
    assert.deepEqual({ order, calculation }, original);
  });
});

test("saveOrder parameterizes customer text rather than interpreting it as SQL", async () => {
  const saveOrder = await loadSaveOrder();
  await withRollback(async () => {
    const { order, calculation } = preparedOrder();
    order.customer.name = "O'Buyer'); DROP TABLE orders; --";
    const confirmation = await saveOrder(client, order, calculation);
    const result = await client.query<{ customer_name: string }>(
      "SELECT customer_name FROM orders WHERE id = $1", [confirmation.orderId],
    );
    assert.equal(result.rows[0]?.customer_name, order.customer.name);
  });
});

test("saveOrder generates a different UUID for each new order", async () => {
  const saveOrder = await loadSaveOrder();
  await withRollback(async () => {
    const { order, calculation } = preparedOrder();
    const first = await saveOrder(client, order, calculation);
    const second = await saveOrder(client, order, calculation);
    assert.notEqual(first.orderId, second.orderId);
    const result = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM orders");
    assert.equal(result.rows[0]?.count, 2);
  });
});

test("saveOrder propagates an insert failure without leaving a partial order", async () => {
  const saveOrder = await loadSaveOrder();
  await withRollback(async () => {
    const { order, calculation } = preparedOrder();
    await client.query("SAVEPOINT failed_insert");
    await assert.rejects(() => saveOrder(client, order, {
      ...calculation, totals: { ...calculation.totals, totalCents: -1 },
    }), { code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT failed_insert");
    const result = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM orders");
    assert.equal(result.rows[0]?.count, 0);
  });
});

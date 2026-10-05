import assert from "node:assert/strict";
import test from "node:test";
import type { ProductSnapshot } from "../src/products.js";

type OrderCalculation = {
  items: Array<ProductSnapshot & { lineTotalCents: number }>;
  totals: {
    subtotalCents: number;
    netSubtotalCents: number;
    vatCents: number;
    shippingCents: number;
    totalCents: number;
  };
};

async function loadCalculation(): Promise<(items: ProductSnapshot[]) => OrderCalculation> {
  const modulePath = "../src/totals.js";
  const { calculateOrderTotals } = await import(modulePath);
  assert.equal(typeof calculateOrderTotals, "function");
  return calculateOrderTotals;
}

function product(unitPriceCents: number, quantity = 1, id = "test-product"): ProductSnapshot {
  return { id, name: "Test headphones", quantity, unitPriceCents };
}

const examples = [
  {
    name: "one product with multiple units",
    items: [product(6000, 2)],
    lines: [12000], subtotal: 12000, net: 10000, vat: 2000, total: 13000,
  },
  {
    name: "multiple products with different quantities",
    items: [product(6000, 2), product(100, 3, "other-product")],
    lines: [12000, 300], subtotal: 12300, net: 10250, vat: 2050, total: 13300,
  },
  {
    name: "half-cent net subtotal rounded upward",
    items: [product(9999)],
    lines: [9999], subtotal: 9999, net: 8333, vat: 1666, total: 10999,
  },
  {
    name: "VAT calculated on the whole order rather than each line",
    items: [product(3), product(3, 1, "other-product")],
    lines: [3, 3], subtotal: 6, net: 5, vat: 1, total: 1006,
  },
  {
    name: "zero-priced product still charged shipping",
    items: [product(0)],
    lines: [0], subtotal: 0, net: 0, vat: 0, total: 1000,
  },
  {
    name: "net subtotal rounded downward",
    items: [product(4)],
    lines: [4], subtotal: 4, net: 3, vat: 1, total: 1004,
  },
  {
    name: "largest safe final amount with exact VAT rounding",
    items: [product(9007199254739991)],
    lines: [9007199254739991], subtotal: 9007199254739991,
    net: 7505999378949993, vat: 1501199875789998, total: 9007199254740991,
  },
];

for (const example of examples) {
  test(`calculates ${example.name}`, async () => {
    const calculateOrderTotals = await loadCalculation();
    const original = structuredClone(example.items);
    const result = calculateOrderTotals(example.items);

    assert.deepEqual(result, {
      items: example.items.map((item, index) => ({
        ...item, lineTotalCents: example.lines[index],
      })),
      totals: {
        subtotalCents: example.subtotal,
        netSubtotalCents: example.net,
        vatCents: example.vat,
        shippingCents: 1000,
        totalCents: example.total,
      },
    });
    assert.equal(result.totals.netSubtotalCents + result.totals.vatCents, result.totals.subtotalCents);
    assert.deepEqual(example.items, original);
  });
}

test("rejects an empty order", async () => {
  const calculateOrderTotals = await loadCalculation();
  assert.throws(() => calculateOrderTotals([]), {
    name: "Error", message: "Order must contain at least one item",
  });
});

const invalidItems = [
  { name: "negative price", item: product(-1) },
  { name: "fractional cent price", item: product(1.5) },
  { name: "unsafe price", item: product(Number.MAX_SAFE_INTEGER + 1) },
  { name: "zero quantity", item: product(100, 0) },
  { name: "fractional quantity", item: product(100, 1.5) },
  { name: "unsafe quantity", item: product(100, Number.MAX_SAFE_INTEGER + 1) },
];

for (const { name, item } of invalidItems) {
  test(`rejects ${name}`, async () => {
    const calculateOrderTotals = await loadCalculation();
    assert.throws(() => calculateOrderTotals([item]), {
      name: "Error", message: "Invalid item price or quantity",
    });
  });
}

const overflowExamples = [
  { name: "line total", items: [product(Number.MAX_SAFE_INTEGER, 2)] },
  {
    name: "subtotal",
    items: [product(Number.MAX_SAFE_INTEGER - 1000), product(1001, 1, "other-product")],
  },
  { name: "total including shipping", items: [product(Number.MAX_SAFE_INTEGER - 999)] },
];

for (const { name, items } of overflowExamples) {
  test(`rejects an unsafe ${name}`, async () => {
    const calculateOrderTotals = await loadCalculation();
    assert.throws(() => calculateOrderTotals(items), {
      name: "Error", message: "Order amount exceeds safe integer range",
    });
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { validateOrderRequest } from "../src/validation.js";

function request() {
  return {
    customer: { name: "Demo Buyer", email: "buyer@example.com", phone: "+381601234567" },
    shippingAddress: { address: "Demo Street 1", zipCode: "11000", city: "Belgrade", country: "Serbia" },
    paymentMethod: "cash",
    items: [{ id: "test-product", quantity: 2 }],
  };
}

test("accepts a valid demo order without an expected total or idempotency key", () => {
  const input = request();
  assert.deepEqual(validateOrderRequest(input), input);
});

test("trims text fields and product IDs without modifying the input", () => {
  const input = {
    ...request(),
    customer: { name: " Demo Buyer ", email: " buyer@example.com ", phone: " +381601234567 " },
    shippingAddress: { address: " Demo Street 1 ", zipCode: " 11000 ", city: " Belgrade ", country: " Serbia " },
    items: [{ id: " test-product ", quantity: 2 }],
  };
  const original = structuredClone(input);
  assert.deepEqual(validateOrderRequest(input), request());
  assert.deepEqual(input, original);
});

for (const value of [undefined, null, [], "invalid"]) {
  test(`rejects a non-object request (${JSON.stringify(value)})`, () => {
    assert.throws(() => validateOrderRequest(value), /Order must be an object/);
  });
}

for (const group of ["customer", "shippingAddress"]) {
  for (const value of [undefined, null, [], "invalid"]) {
    test(`rejects invalid ${group} (${JSON.stringify(value)})`, () => {
      assert.throws(() => validateOrderRequest({ ...request(), [group]: value }), /must be an object/);
    });
  }
}

const fields = [
  { group: "customer", field: "name", max: 100 },
  { group: "customer", field: "email", max: 254 },
  { group: "customer", field: "phone", max: 32 },
  { group: "shippingAddress", field: "address", max: 200 },
  { group: "shippingAddress", field: "zipCode", max: 20 },
  { group: "shippingAddress", field: "city", max: 100 },
  { group: "shippingAddress", field: "country", max: 100 },
] as const;

for (const { group, field, max } of fields) {
  for (const value of [undefined, "", "   ", 123, "x".repeat(max + 1)]) {
    test(`rejects invalid ${field} (${typeof value}, length ${String(value).length})`, () => {
      const input = request();
      assert.throws(() => validateOrderRequest({
        ...input, [group]: { ...input[group], [field]: value },
      }), new RegExp(`Invalid ${field}`));
    });
  }
}

for (const email of ["buyer", "buyer@example", "buyer @example.com", "buyer@example.c"]) {
  test(`rejects invalid email ${email}`, () => {
    const input = request();
    assert.throws(() => validateOrderRequest({
      ...input, customer: { ...input.customer, email },
    }), /Invalid email/);
  });
}

for (const phone of ["123", "+381abc123", "123/456"]) {
  test(`rejects invalid phone ${phone}`, () => {
    const input = request();
    assert.throws(() => validateOrderRequest({
      ...input, customer: { ...input.customer, phone },
    }), /Invalid phone/);
  });
}

test("accepts checkout phone formatting", () => {
  const input = request();
  const phone = "+381 (60) 123-4567";
  assert.equal(validateOrderRequest({
    ...input, customer: { ...input.customer, phone },
  }).customer.phone, phone);
});

for (const paymentMethod of [undefined, "e-money", "card", " cash ", 123]) {
  test(`rejects unsupported payment method ${paymentMethod}`, () => {
    assert.throws(() => validateOrderRequest({ ...request(), paymentMethod }), /Only cash payment is supported/);
  });
}

for (const items of [undefined, null, {}, [], Array.from({ length: 51 }, (_, i) => ({ id: `product-${i}`, quantity: 1 }))]) {
  test(`rejects invalid items (${Array.isArray(items) ? items.length : typeof items})`, () => {
    assert.throws(() => validateOrderRequest({ ...request(), items }), /Order must contain 1 to 50 items/);
  });
}

for (const item of [null, [], "invalid"]) {
  test(`rejects a non-object item (${JSON.stringify(item)})`, () => {
    assert.throws(() => validateOrderRequest({ ...request(), items: [item] }), /Item must be an object/);
  });
}

for (const id of [undefined, "", "   ", 123, "x".repeat(101)]) {
  test(`rejects invalid product ID (${typeof id}, length ${String(id).length})`, () => {
    assert.throws(() => validateOrderRequest({
      ...request(), items: [{ id, quantity: 1 }],
    }), /Invalid id/);
  });
}

for (const quantity of [undefined, null, "2", 0, -1, 1.5, 100, NaN, Infinity]) {
  test(`rejects invalid quantity ${quantity}`, () => {
    assert.throws(() => validateOrderRequest({
      ...request(), items: [{ id: "test-product", quantity }],
    }), /Quantity must be an integer from 1 to 99/);
  });
}

test("rejects duplicate product IDs after trimming", () => {
  assert.throws(() => validateOrderRequest({
    ...request(),
    items: [{ id: "test-product", quantity: 1 }, { id: " test-product ", quantity: 2 }],
  }), /Product IDs must be unique/);
});

const unexpectedFields = [
  { ...request(), expectedTotalCents: 13000 },
  { ...request(), price: 1 },
  { ...request(), customer: { ...request().customer, role: "admin" } },
  { ...request(), shippingAddress: { ...request().shippingAddress, extra: "value" } },
  ...["price", "name", "inStock"].map((field) => ({
    ...request(), items: [{ id: "test-product", quantity: 1, [field]: 1 }],
  })),
];

for (const [index, input] of unexpectedFields.entries()) {
  test(`rejects unexpected fields (${index + 1})`, () => {
    assert.throws(() => validateOrderRequest(input), /contains unsupported fields/);
  });
}

test("accepts agreed field, quantity, and item-count limits", () => {
  const input = {
    ...request(),
    customer: { name: "n".repeat(100), email: `${"e".repeat(242)}@example.com`, phone: "1".repeat(32) },
    shippingAddress: { address: "a".repeat(200), zipCode: "z".repeat(20), city: "c".repeat(100), country: "c".repeat(100) },
    items: Array.from({ length: 50 }, (_, i) => ({ id: String(i).padStart(100, "x"), quantity: 99 })),
  };
  assert.deepEqual(validateOrderRequest(input), input);
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { loadOrderProducts } from "../src/products.js";

function createProduct(id = "test-product", price = 99.99) {
  return {
    id,
    shortName: "Test headphones",
    price,
    inStock: 5,
    title: "Test product title",
    images: { cover: "/test/cover.webp" },
  };
}

async function withProductsServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");

  try {
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

function sendJson(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("loads requested products and creates snapshots with prices in cents", async () => {
  const requestedPaths: string[] = [];
  const products = new Map([
    ["/products/test-first", createProduct("test-first", 99.99)],
    ["/products/test-second", createProduct("test-second", 0.29)],
  ]);

  await withProductsServer((request, response) => {
    requestedPaths.push(request.url ?? "");
    assert.equal(request.method, "GET");
    const product = products.get(request.url ?? "");
    sendJson(response, product ?? { error: "Product not found" }, product ? 200 : 404);
  }, async (baseUrl) => {
    const result = await loadOrderProducts([
      { id: "test-first", quantity: 2 },
      { id: "test-second", quantity: 1 },
    ], baseUrl);

    assert.deepEqual(result, [
      { id: "test-first", name: "Test headphones", quantity: 2, unitPriceCents: 9999 },
      { id: "test-second", name: "Test headphones", quantity: 1, unitPriceCents: 29 },
    ]);
    assert.deepEqual(requestedPaths.sort(), [...products.keys()].sort());
  });
});

test("accepts a quantity equal to inStock", async () => {
  await withProductsServer((_request, response) => {
    sendJson(response, createProduct());
  }, async (baseUrl) => {
    assert.deepEqual(await loadOrderProducts([{ id: "test-product", quantity: 5 }], baseUrl), [
      { id: "test-product", name: "Test headphones", quantity: 5, unitPriceCents: 9999 },
    ]);
  });
});

test("accepts a zero unit price", async () => {
  await withProductsServer((_request, response) => {
    sendJson(response, createProduct("test-product", 0));
  }, async (baseUrl) => {
    const result = await loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl);
    assert.equal(result[0]?.unitPriceCents, 0);
  });
});

for (const [price, cents] of [[1.234, 123], [1.236, 124], [100000.01, 10000001]]) {
  test(`converts EUR ${price} to ${cents} cents using Math.round`, async () => {
    await withProductsServer((_request, response) => {
      sendJson(response, createProduct("test-product", price));
    }, async (baseUrl) => {
      const result = await loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl);
      assert.equal(result[0]?.unitPriceCents, cents);
    });
  });
}

test("reports a missing product with an ordinary Error", async () => {
  await withProductsServer((_request, response) => {
    sendJson(response, { error: "Product not found" }, 404);
  }, async (baseUrl) => {
    await assert.rejects(
      () => loadOrderProducts([{ id: "missing-product", quantity: 1 }], baseUrl),
      { name: "Error", message: "Product not found" },
    );
  });
});

for (const inStock of [0, 1]) {
  test(`rejects insufficient stock (${inStock})`, async () => {
    await withProductsServer((_request, response) => {
      sendJson(response, { ...createProduct(), inStock });
    }, async (baseUrl) => {
      await assert.rejects(
        () => loadOrderProducts([{ id: "test-product", quantity: 2 }], baseUrl),
        { name: "Error", message: "Requested quantity exceeds available stock" },
      );
    });
  });
}

const invalidProducts: Array<{ name: string; body: unknown }> = [
  { name: "null body", body: null },
  { name: "array body", body: [createProduct()] },
  { name: "wrapped product", body: { product: createProduct() } },
  { name: "missing ID", body: { ...createProduct(), id: undefined } },
  { name: "mismatched ID", body: { ...createProduct(), id: "other-product" } },
  { name: "missing shortName", body: { ...createProduct(), shortName: undefined } },
  { name: "empty shortName", body: { ...createProduct(), shortName: "" } },
  { name: "blank shortName", body: { ...createProduct(), shortName: "   " } },
  { name: "non-string shortName", body: { ...createProduct(), shortName: 123 } },
  { name: "missing price", body: { ...createProduct(), price: undefined } },
  { name: "null price", body: { ...createProduct(), price: null } },
  { name: "string price", body: { ...createProduct(), price: "99.99" } },
  { name: "negative price", body: { ...createProduct(), price: -0.01 } },
  { name: "unsafe cent price", body: { ...createProduct(), price: Number.MAX_VALUE } },
  { name: "missing stock", body: { ...createProduct(), inStock: undefined } },
  { name: "null stock", body: { ...createProduct(), inStock: null } },
  { name: "string stock", body: { ...createProduct(), inStock: "5" } },
  { name: "negative stock", body: { ...createProduct(), inStock: -1 } },
  { name: "fractional stock", body: { ...createProduct(), inStock: 1.5 } },
];

for (const { name, body } of invalidProducts) {
  test(`rejects ${name}`, async () => {
    await withProductsServer((_request, response) => {
      sendJson(response, body);
    }, async (baseUrl) => {
      await assert.rejects(
        () => loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl),
        { name: "Error", message: "Products service returned an invalid response" },
      );
    });
  });
}

test("rejects malformed JSON", async () => {
  await withProductsServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{broken-json");
  }, async (baseUrl) => {
    await assert.rejects(
      () => loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl),
      { name: "Error", message: "Products service returned an invalid response" },
    );
  });
});

for (const status of [500, 503]) {
  test(`reports products HTTP ${status} as unavailable`, async () => {
    await withProductsServer((_request, response) => {
      response.writeHead(status);
      response.end("upstream error");
    }, async (baseUrl) => {
      await assert.rejects(
        () => loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl),
        { name: "Error", message: "Products service is unavailable" },
      );
    });
  });
}

test("reports a dropped connection as unavailable", async () => {
  await withProductsServer((request) => {
    request.socket.destroy();
  }, async (baseUrl) => {
    await assert.rejects(
      () => loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl),
      { name: "Error", message: "Products service is unavailable" },
    );
  });
});

for (const sendHeaders of [false, true]) {
  test(`applies the five-second deadline while waiting for ${sendHeaders ? "body" : "headers"}`, { timeout: 8000 }, async () => {
    await withProductsServer((_request, response) => {
      if (sendHeaders) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
      }
    }, async (baseUrl) => {
      const startedAt = performance.now();
      await assert.rejects(
        () => loadOrderProducts([{ id: "test-product", quantity: 1 }], baseUrl),
        { name: "Error", message: "Products service is unavailable" },
      );
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 4500 && elapsed < 6500, `Expected a five-second deadline, received ${elapsed} ms`);
    });
  });
}

test("uses one five-second deadline for the entire product lookup", { timeout: 8000 }, async () => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let firstFinished: () => void = () => {};
  const firstResponse = new Promise<void>((resolve) => { firstFinished = resolve; });

  try {
    await withProductsServer((request, response) => {
      if (request.url === "/products/test-first") {
        timers.push(setTimeout(() => {
          sendJson(response, createProduct("test-first"));
          firstFinished();
        }, 3000));
      } else {
        void firstResponse.then(() => {
          timers.push(setTimeout(() => {
            sendJson(response, createProduct("test-second"));
          }, 3000));
        });
      }
    }, async (baseUrl) => {
      const startedAt = performance.now();
      await assert.rejects(
        () => loadOrderProducts([
          { id: "test-first", quantity: 1 },
          { id: "test-second", quantity: 1 },
        ], baseUrl),
        { name: "Error", message: "Products service is unavailable" },
      );
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed >= 4500 && elapsed < 5800, `Expected a shared five-second deadline, received ${elapsed} ms`);
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});
export type OrderItem = {
  id: string;
  quantity: number;
};

export type ProductSnapshot = {
  id: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
};

function snapshot(product: unknown, item: OrderItem): ProductSnapshot {
  if (
    typeof product !== "object" ||
    product === null ||
    Array.isArray(product) ||
    !("id" in product) ||
    product.id !== item.id ||
    !("shortName" in product) ||
    typeof product.shortName !== "string" ||
    product.shortName.trim() === "" ||
    !("price" in product) ||
    typeof product.price !== "number" ||
    !Number.isFinite(product.price) ||
    product.price < 0 ||
    !("inStock" in product) ||
    typeof product.inStock !== "number" ||
    !Number.isSafeInteger(product.inStock) ||
    product.inStock < 0
  ) {
    throw new Error("Products service returned an invalid response");
  }

  const unitPriceCents = Math.round(product.price * 100);
  if (!Number.isSafeInteger(unitPriceCents)) {
    throw new Error("Products service returned an invalid response");
  }
  if (item.quantity > product.inStock) {
    throw new Error("Requested quantity exceeds available stock");
  }

  return {
    id: product.id,
    name: product.shortName,
    quantity: item.quantity,
    unitPriceCents,
  };
}

async function readProduct(url: URL, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: "error" });
  } catch (error) {
    throw new Error("Products service is unavailable", { cause: error });
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 404 ? "Product not found" : "Products service is unavailable");
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      error instanceof SyntaxError
        ? "Products service returned an invalid response"
        : "Products service is unavailable",
      { cause: error },
    );
  }
}

export async function loadOrderProducts(
  items: OrderItem[],
  productsServiceUrl: string,
): Promise<ProductSnapshot[]> {
  const baseUrl = new URL(productsServiceUrl);
  const signal = AbortSignal.timeout(5000);
  const products: ProductSnapshot[] = [];

  for (const item of items) {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/products/${encodeURIComponent(item.id)}`;
    url.search = "";
    url.hash = "";
    products.push(snapshot(await readProduct(url, signal), item));
  }
  return products;
}

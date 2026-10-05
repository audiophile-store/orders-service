import type { ProductSnapshot } from "./products.js";

export function calculateOrderTotals(products: ProductSnapshot[]) {
  if (products.length === 0) {
    throw new Error("Order must contain at least one item");
  }

  let subtotalCents = 0;
  const items = products.map((product) => {
    if (
      !Number.isSafeInteger(product.unitPriceCents) ||
      product.unitPriceCents < 0 ||
      !Number.isSafeInteger(product.quantity) ||
      product.quantity < 1
    ) {
      throw new Error("Invalid item price or quantity");
    }

    const lineTotalCents = product.unitPriceCents * product.quantity;
    subtotalCents += lineTotalCents;
    if (!Number.isSafeInteger(lineTotalCents) || !Number.isSafeInteger(subtotalCents)) {
      throw new Error("Order amount exceeds safe integer range");
    }

    return { ...product, lineTotalCents };
  });

  const shippingCents = 1000;
  const totalCents = subtotalCents + shippingCents;
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error("Order amount exceeds safe integer range");
  }

  // Dividing by 1.20 is multiplying by 5/6; BigInt keeps half-cent rounding exact.
  const netSubtotalCents = Number((BigInt(subtotalCents) * 5n + 3n) / 6n);
  const vatCents = subtotalCents - netSubtotalCents;

  return {
    items,
    totals: { subtotalCents, netSubtotalCents, vatCents, shippingCents, totalCents },
  };
}

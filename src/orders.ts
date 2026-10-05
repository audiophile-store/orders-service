import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import type { calculateOrderTotals } from "./totals.js";
import type { validateOrderRequest } from "./validation.js";

export async function saveOrder(
  database: Client | Pool,
  order: ReturnType<typeof validateOrderRequest>,
  calculation: ReturnType<typeof calculateOrderTotals>,
) {
  const { customer, shippingAddress, paymentMethod } = order;
  const { items, totals } = calculation;
  const result = await database.query<{ id: string; created_at: Date }>(
    `INSERT INTO orders (
      id, customer_name, customer_email, customer_phone,
      shipping_address, shipping_zip_code, shipping_city, shipping_country,
      payment_method, currency, subtotal_cents, net_subtotal_cents,
      vat_cents, shipping_cents, total_cents, items
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16
    ) RETURNING id, created_at`,
    [
      randomUUID(), customer.name, customer.email, customer.phone,
      shippingAddress.address, shippingAddress.zipCode, shippingAddress.city, shippingAddress.country,
      paymentMethod, "EUR", totals.subtotalCents, totals.netSubtotalCents,
      totals.vatCents, totals.shippingCents, totals.totalCents, JSON.stringify(items),
    ],
  );

  const saved = result.rows[0];
  if (!saved) {
    throw new Error("Order insert returned no confirmation");
  }
  return { orderId: saved.id, createdAt: saved.created_at.toISOString() };
}

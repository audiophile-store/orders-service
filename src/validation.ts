function readObject(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object: Record<string, unknown> = { ...value };
  if (Object.keys(object).some((key) => !fields.includes(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return object;
}

function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return value.trim();
}

export function validateOrderRequest(body: unknown) {
  const order = readObject(body, ["customer", "shippingAddress", "paymentMethod", "items"], "Order");
  const customer = readObject(order.customer, ["name", "email", "phone"], "Customer");
  const shipping = readObject(order.shippingAddress, ["address", "zipCode", "city", "country"], "Shipping address");

  const name = readText(customer.name, "name", 100);
  const email = readText(customer.email, "email", 254);
  const phone = readText(customer.phone, "phone", 32);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new Error("Invalid email");
  }
  if (!/^\+?[\d\s()-]{6,}$/.test(phone)) {
    throw new Error("Invalid phone");
  }

  const shippingAddress = {
    address: readText(shipping.address, "address", 200),
    zipCode: readText(shipping.zipCode, "zipCode", 20),
    city: readText(shipping.city, "city", 100),
    country: readText(shipping.country, "country", 100),
  };

  if (order.paymentMethod !== "cash") {
    throw new Error("Only cash payment is supported");
  }
  if (!Array.isArray(order.items) || order.items.length === 0 || order.items.length > 50) {
    throw new Error("Order must contain 1 to 50 items");
  }

  const seenIds = new Set<string>();
  const items = order.items.map((value: unknown) => {
    const item = readObject(value, ["id", "quantity"], "Item");
    const id = readText(item.id, "id", 100);
    const quantity = item.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error("Quantity must be an integer from 1 to 99");
    }
    if (seenIds.has(id)) {
      throw new Error("Product IDs must be unique");
    }
    seenIds.add(id);
    return { id, quantity };
  });

  return { customer: { name, email, phone }, shippingAddress, paymentMethod: "cash" as const, items };
}

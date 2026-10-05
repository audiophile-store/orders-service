import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Client, Pool } from "pg";
import { saveOrder } from "./orders.js";
import { loadOrderProducts } from "./products.js";
import type { ProductSnapshot } from "./products.js";
import { calculateOrderTotals } from "./totals.js";
import { validateOrderRequest } from "./validation.js";

const productsErrorStatus: Record<string, number> = {
  "Product not found": 422,
  "Requested quantity exceeds available stock": 409,
  "Products service is unavailable": 503,
  "Products service returned an invalid response": 503,
};

export function createApp(database: Client | Pool, productsServiceUrl: string) {
  const app = express();

  app.post("/orders", express.json({ limit: "32kb" }), async (request, response) => {
    let order: ReturnType<typeof validateOrderRequest>;
    try {
      order = validateOrderRequest(request.body);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return response.status(400).json({ error: error.message });
    }

    let products: ProductSnapshot[];
    try {
      products = await loadOrderProducts(order.items, productsServiceUrl);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const status = productsErrorStatus[error.message];
      if (!status) throw error;
      return response.status(status).json({ error: error.message });
    }

    let calculation: ReturnType<typeof calculateOrderTotals>;
    try {
      calculation = calculateOrderTotals(products);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Order amount exceeds safe integer range") {
        throw error;
      }
      return response.status(400).json({ error: error.message });
    }

    const confirmation = await saveOrder(database, order, calculation);
    return response.status(201).json({
      ...confirmation, currency: "EUR", paymentMethod: order.paymentMethod, ...calculation,
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.parse.failed") {
        return response.status(400).json({ error: "Invalid JSON" });
      }
      if (error.type === "entity.too.large") {
        return response.status(413).json({ error: "Request body too large" });
      }
    }
    console.error("Order request failed");
    return response.status(500).json({ error: "Could not create order" });
  });

  return app;
}
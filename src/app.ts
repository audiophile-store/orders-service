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

export function createApp(
  database: Client | Pool,
  productsServiceUrl: string,
  appVersion = "0.1.0",
  corsOrigin?: string,
) {
  const allowedOrigin = corsOrigin?.trim();
  if (allowedOrigin) {
    const url = URL.canParse(allowedOrigin) ? new URL(allowedOrigin) : undefined;
    if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== allowedOrigin) {
      throw new Error("CORS_ORIGIN must be an HTTP(S) origin without a path or credentials");
    }
  }
  const app = express();

  app.use((request, response, next) => {
    if (allowedOrigin) {
      response.vary("Origin");
      if (request.get("Origin") === allowedOrigin) {
        response.set("Access-Control-Allow-Origin", allowedOrigin);
      }
    }
    next();
  });

  app.options("/orders", (request, response, next) => {
    const origin = request.get("Origin");
    const method = request.get("Access-Control-Request-Method");
    if (!origin || !method) return next();

    response.vary("Origin");
    response.vary("Access-Control-Request-Method");
    response.vary("Access-Control-Request-Headers");
    const headers = request.get("Access-Control-Request-Headers");
    const unsupportedHeaders = headers?.split(",").some(
      (header) => header.trim().toLowerCase() !== "content-type",
    );
    if (!allowedOrigin || origin !== allowedOrigin || method !== "POST" || unsupportedHeaders) {
      console.error("Order CORS preflight rejected");
      return response.status(403).json({ error: "CORS preflight rejected" });
    }

    return response.set({
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
    }).status(204).end();
  });

  app.get("/health", (_request, response) => {
    return response.set("Cache-Control", "no-store").json({ status: "ok" });
  });

  app.get("/ready", async (_request, response) => {
    response.set("Cache-Control", "no-store");
    const query = {
      text: `SELECT id, created_at, customer_name, customer_email, customer_phone,
        shipping_address, shipping_zip_code, shipping_city, shipping_country,
        payment_method, currency, subtotal_cents, net_subtotal_cents, vat_cents,
        shipping_cents, total_cents, items FROM orders WHERE FALSE`,
      query_timeout: 2000,
    };
    try {
      await database.query(query);
    } catch {
      console.error("Database readiness check failed");
      return response.status(503).json({ status: "not_ready" });
    }
    return response.json({ status: "ready" });
  });

  app.get("/version", (_request, response) => {
    return response.set("Cache-Control", "no-store").json({ version: appVersion });
  });

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
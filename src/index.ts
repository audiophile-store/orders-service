import { createApp } from "./app.js";
import { pool } from "./db.js";

const productsServiceUrl = process.env.PRODUCTS_SERVICE_URL;
if (!productsServiceUrl?.trim()) {
  throw new Error("PRODUCTS_SERVICE_URL is required");
}

const appVersion = process.env.APP_VERSION?.trim() || "0.1.0";
const app = createApp(pool, productsServiceUrl, appVersion);
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`orders service listening on port ${PORT}`);
});
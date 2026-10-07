import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2000,
});

pool.on("error", () => {
  console.error("Database connection error");
});

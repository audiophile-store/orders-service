import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runPool(script: string, databaseUrl: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 10000,
  });
}

test("pool requires DATABASE_URL instead of using default connection settings", () => {
  const result = runPool('await import("./src/db.js");', "");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("pool uses the configured URL without connecting on import", () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "Set TEST_DATABASE_URL for pool tests");
  const result = runPool(`
    import assert from "node:assert/strict";
    const { pool } = await import("./src/db.js");
    assert.equal(pool.options.connectionString, process.env.DATABASE_URL);
    assert.equal(pool.totalCount, 0);
    await pool.end();
  `, url);
  assert.equal(result.status, 0, result.stderr);
});

test("pool logs idle connection errors without exposing connection details", () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "Set TEST_DATABASE_URL for pool tests");
  const result = runPool(`
    const { pool } = await import("./src/db.js");
    pool.emit("error", new Error("private connection details"));
    await pool.end();
  `, url);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), "Database connection error");
});

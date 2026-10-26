import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Store, dateRange, HALF_HOUR } from "../build/api.mjs";

test("stdio client discovers tools, reads coverage and compares actual cached data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "energy-lens-mcp-test-"));
  const range = dateRange("2026-01-01", "2026-01-02"),
    store = new Store(join(dir, "readings.sqlite"));
  store.putStream({ id: "synthetic", name: "Synthetic meter", source: "csv" });
  store.save(
    "synthetic",
    Array.from({ length: 48 }, (_, i) => ({
      start: range.start + i * HALF_HOUR,
      kwh: 1,
    })),
  );
  store.close();
  const client = new Client({ name: "energy-lens-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/server.mjs"],
    env: {
      PATH: process.env.PATH,
      ENERGY_LENS_DATA_DIR: dir,
      GLOW_USERNAME: "",
      GLOW_PASSWORD: "",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b.toString()));
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((x) => x.name).sort(), [
    "calculate_cost",
    "compare_tariffs",
    "get_usage",
    "list_meters",
    "meter_status",
    "sync_history",
  ]);
  const status = await client.callTool({ name: "meter_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.streams[0].intervals, 48);
  const data = await client.callTool({
    name: "get_usage",
    arguments: { from: range.from, to: range.to },
  });
  assert.equal(data.structuredContent.recordedKwh, 48);
  assert.equal(data.structuredContent.coverage.complete, true);
  const tariffs = JSON.parse(await readFile("examples/tariffs.json", "utf8"));
  const comparison = await client.callTool({
    name: "compare_tariffs",
    arguments: { from: range.from, to: range.to, tariffs },
  });
  assert.equal(comparison.isError, undefined);
  assert.equal(comparison.structuredContent.ranking.length, 2);
  const invalid = await client.callTool({
    name: "get_usage",
    arguments: { from: "2026-02-30", to: "2026-03-03" },
  });
  assert.equal(invalid.isError, true);
  assert.ok(!stderr.includes("password"));
  assert.ok(!stderr.includes("fake-test-token"));
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  GlowClient,
  Store,
  dateRange,
  syncHistory,
  DAY,
  HALF_HOUR,
} from "../build/api.mjs";

const resource = {
  resourceId: "test-meter",
  classifier: "electricity.consumption",
  baseUnit: "kWh",
  entityName: "Test home",
};
function fixture(override) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const custom = await override?.(u, init, calls);
    if (custom) return custom;
    if (u.pathname.endsWith("/auth"))
      return Response.json({
        valid: true,
        token: "fake-test-token",
        exp: Date.now() / 1000 + 3600,
      });
    if (u.pathname.endsWith("/virtualentity"))
      return Response.json([{ veId: "home", name: "Test home" }]);
    if (u.pathname.endsWith("/resources"))
      return Response.json({ resources: [resource] });
    const from = Date.parse(u.searchParams.get("from") + "Z"),
      end = Date.parse(u.searchParams.get("to") + "Z") + 1000;
    return Response.json({
      status: "OK",
      data: Array.from({ length: (end - from) / HALF_HOUR }, (_, i) => [
        (from + i * HALF_HOUR) / 1000,
        0.5,
      ]),
    });
  };
  return {
    client: new GlowClient(
      async () => ({
        username: "synthetic@example.invalid",
        password: "test-only-password",
      }),
      fetch,
      async () => {},
    ),
    calls,
  };
}

test("history is chunked at ten days, UTC, without dropped boundaries; second run can reuse cache", async () => {
  const { client, calls } = fixture(),
    store = new Store(":memory:"),
    range = dateRange("2026-01-01", "2026-01-24"),
    now = range.end + 10 * DAY;
  const result = await syncHistory(store, client, range, { now, delayMs: 0 });
  const reads = calls.filter((c) => c.url.includes("/readings?"));
  assert.equal(reads.length, 3);
  assert.equal(result.availableIntervals, 23 * 48);
  for (const c of reads) {
    const u = new URL(c.url);
    assert.equal(u.searchParams.get("offset"), "0");
    assert.equal(u.searchParams.get("period"), "PT30M");
    assert.ok(
      Date.parse(u.searchParams.get("to") + "Z") -
        Date.parse(u.searchParams.get("from") + "Z") <
        10 * DAY,
    );
  }
  const second = await syncHistory(store, client, range, { now, delayMs: 0 });
  assert.equal(second.cachedChunks, 3);
  store.close();
});
test("null readings remain gaps while genuine zero consumption is kept", async () => {
  const range = dateRange("2026-01-01", "2026-01-02");
  const { client } = fixture((u) =>
    u.pathname.endsWith("/readings")
      ? Response.json({
          data: [
            [range.start / 1000, 0],
            [(range.start + HALF_HOUR) / 1000, null],
          ],
        })
      : null,
  );
  assert.deepEqual(await client.readings(resource, range.start, range.end), [
    { start: range.start, kwh: 0 },
  ]);
});
test("interrupted downloads retain completed chunks and resume without duplicates", async () => {
  const range = dateRange("2026-01-01", "2026-01-24"),
    store = new Store(":memory:");
  let reads = 0,
    fail = true;
  const { client } = fixture((u) => {
    if (u.pathname.endsWith("/readings") && ++reads === 2 && fail)
      throw new Error("network detail with secret");
  });
  await assert.rejects(
    syncHistory(store, client, range, {
      now: range.end + 10 * DAY,
      delayMs: 0,
    }),
    /could not be reached/,
  );
  assert.equal(
    store.readings("glow:test-meter", range.start, range.end).length,
    480,
  );
  fail = false;
  const result = await syncHistory(store, client, range, {
    now: range.end + 10 * DAY,
    delayMs: 0,
  });
  assert.equal(result.availableIntervals, 1104);
  store.close();
});
test("incomplete chunks are revisited so delayed backfill can arrive", async () => {
  const range = dateRange("2026-01-01", "2026-01-02"),
    store = new Store(":memory:");
  let empty = true;
  const { client } = fixture((u) =>
    u.pathname.endsWith("/readings") && empty
      ? Response.json({ data: [] })
      : null,
  );
  await syncHistory(store, client, range, {
    now: range.end + 10 * DAY,
    delayMs: 0,
  });
  empty = false;
  const result = await syncHistory(store, client, range, {
    now: range.end + 10 * DAY,
    delayMs: 0,
  });
  assert.equal(result.availableIntervals, 48);
  store.close();
});
test("expired token is renewed once and rate limits are retried with bounded delay", async () => {
  let entities = 0,
    auth = 0;
  const { client } = fixture((u) => {
    if (u.pathname.endsWith("/auth")) auth++;
    if (u.pathname.endsWith("/virtualentity")) {
      entities++;
      if (entities === 1) return new Response("", { status: 401 });
      if (entities === 2)
        return new Response("", {
          status: 429,
          headers: { "retry-after": "9999" },
        });
    }
  });
  assert.equal((await client.resources()).length, 1);
  assert.equal(auth, 2);
  assert.equal(entities, 3);
});
test("wrong resource units and malformed data are rejected instead of treated as kWh", async () => {
  const range = dateRange("2026-01-01", "2026-01-02");
  const { client } = fixture((u) =>
    u.pathname.endsWith("/readings")
      ? Response.json({ data: [[range.start / 1000, -1]] })
      : null,
  );
  await assert.rejects(
    client.readings({ ...resource, baseUnit: "pence" }, range.start, range.end),
    /kWh/,
  );
  await assert.rejects(
    client.readings(resource, range.start, range.end),
    /invalid consumption/,
  );
});

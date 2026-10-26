import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Aedes } from "aedes";
import { connect } from "mqtt";
import { Store, livePower, startPowerApi, collectMqtt } from "../build/api.mjs";

function fixture(t) {
  const store = new Store(":memory:");
  store.putStream({ id: "mqtt:home", name: "Synthetic CAD", source: "mqtt" });
  t.after(() => store.close());
  return store;
}

async function api(t, store, options = {}) {
  const server = await startPowerApi(store, { port: 0, ...options });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}/v1/power`;
}

test("live power distinguishes missing, measured zero, stale and clock-skewed data", (t) => {
  const store = fixture(t);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(livePower(store, "mqtt:home", now), {
    streamId: "mqtt:home",
    status: "unavailable",
    observedAt: null,
    ageSeconds: null,
    powerWatts: null,
    lastObservedPowerWatts: null,
    cumulativeImportKwh: null,
  });
  store.saveLive({
    stream: "mqtt:home",
    time: now,
    powerKw: 0,
    cumulativeKwh: 100,
  });
  assert.equal(livePower(store, "mqtt:home", now).powerWatts, 0);
  assert.equal(livePower(store, "mqtt:home", now + 60_000).status, "live");
  const stale = livePower(store, "mqtt:home", now + 60_001);
  assert.equal(stale.status, "stale");
  assert.equal(stale.powerWatts, null);
  assert.equal(stale.lastObservedPowerWatts, 0);
  const future = livePower(store, "mqtt:home", now - 10_000);
  assert.equal(future.status, "clock_skew");
  assert.equal(future.powerWatts, null);
});

test("HTTP API exposes one stream and rejects writes, browser requests and DNS rebinding", async (t) => {
  const store = fixture(t);
  const url = await api(t, store);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await response.json()).status, "unavailable");
  for (const [options, expected] of [
    [{ method: "POST", body: "{}" }, 405],
    [{ method: "OPTIONS" }, 405],
    [{ headers: { Origin: "https://example.com" } }, 403],
    [{ headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    [{ headers: { Host: "attacker.example" } }, 403],
  ]) {
    // Browser-style fetch may override Host / Sec-Fetch-*; send exact headers.
    const denied = await new Promise((resolve, reject) => {
      const req = request(url, options, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      });
      req.on("error", reject);
      req.end(options.body);
    });
    assert.equal(denied.status, expected);
    assert.ok(!denied.body.includes("powerWatts"));
  }
  assert.equal((await fetch(`${url}?stream=other`)).status, 404);
});

test("remote binding requires a token and authenticated requests must match it", async (t) => {
  const store = fixture(t);
  await assert.rejects(
    startPowerApi(store, { host: "0.0.0.0", port: 0 }),
    /TOKEN/,
  );
  const token = "synthetic-test-token-that-is-not-a-secret";
  const url = await api(t, store, { token });
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
    401,
  );
  assert.equal((await fetch(`${url}?token=${token}`)).status, 401);
  const authorized = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).status, "unavailable");
});

test("API rejects invalid options before opening a listener", async (t) => {
  const store = fixture(t);
  for (const options of [
    { host: "localhost" },
    { port: NaN },
    { port: 65536 },
    { port: 1.5 },
    { stream: "" },
    { stream: "bad\nstream" },
    { staleAfterSeconds: NaN },
    { staleAfterSeconds: 0 },
    { staleAfterSeconds: 3601 },
    { token: "" },
    { token: "short" },
    { token: "a token with spaces is not permitted" },
  ])
    await assert.rejects(startPowerApi(store, options));
});

test("MQTT to SQLite to HTTP serves fresh watts across independent database connections", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "energy-power-"));
  const collectorStore = new Store(join(directory, "readings.sqlite"));
  const readerStore = new Store(join(directory, "readings.sqlite"));
  const broker = await Aedes.createBroker();
  const listener = createServer(broker.handle);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const brokerUrl = `mqtt://127.0.0.1:${listener.address().port}`;
  const topic = "glow/synthetic/SENSOR/electricitymeter";
  const collector = await collectMqtt(collectorStore, {
    broker: brokerUrl,
    topic,
    stream: "mqtt:home",
  });
  const publisher = connect(brokerUrl);
  await once(publisher, "connect");
  t.after(async () => {
    await publisher.endAsync();
    await collector.endAsync();
    await broker.close();
    await new Promise((resolve) => listener.close(resolve));
    readerStore.close();
    collectorStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const url = await api(t, readerStore);
  const observed = Date.now() - 1000;
  await publisher.publishAsync(
    topic,
    JSON.stringify({
      electricitymeter: {
        timestamp: new Date(observed).toISOString(),
        energy: { import: { cumulative: 123.5, units: "kWh" } },
        power: { value: 2.1, units: "kW" },
      },
    }),
    { qos: 1 },
  );
  let result;
  const deadline = Date.now() + 3000;
  do {
    result = await (await fetch(url)).json();
    if (result.status === "live") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(result.status, "live");
  assert.equal(result.powerWatts, 2100);
  assert.equal(result.cumulativeImportKwh, 123.5);
  assert.equal(result.observedAt, new Date(observed).toISOString());
  assert.ok(result.ageSeconds >= 0 && result.ageSeconds < 10);
  assert.equal(collectorStore.readings("mqtt:home", 0, Date.now()).length, 0);
});

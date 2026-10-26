import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { Aedes } from "aedes";
import { connect } from "mqtt";
import {
  Store,
  acceptCadMessage,
  collectMqtt,
  HALF_HOUR,
} from "../build/api.mjs";

const start = Date.parse("2026-01-01T00:00:00Z");
const payload = (time, cumulative, extra = {}) =>
  JSON.stringify({
    electricitymeter: {
      timestamp: new Date(time).toISOString(),
      energy: { import: { cumulative, units: "kWh" } },
      power: { value: 2, units: "kW" },
      ...extra,
    },
  });
const storeForCad = () => {
  const s = new Store(":memory:");
  s.putStream({ id: "cad", name: "Test CAD", source: "mqtt" });
  return s;
};

test("CAD collection preserves cumulative data and labels half-hour estimates", () => {
  const store = storeForCad();
  for (let time = start; time <= start + HALF_HOUR; time += 10_000)
    acceptCadMessage(
      store,
      "cad",
      payload(time, 100 + (time - start) / 3_600_000),
      time,
    );
  const records = store.readings("cad", start, start + HALF_HOUR);
  assert.equal(records.length, 1);
  assert.ok(Math.abs(records[0].kwh - 0.5) < 1e-8);
  assert.equal(records[0].estimated, true);
  assert.equal(store.latestLive("cad").powerKw, 2);
  store.close();
});
test("CAD gaps and meter resets never create invented half-hour readings", () => {
  const store = storeForCad();
  acceptCadMessage(store, "cad", payload(start, 100), start);
  acceptCadMessage(
    store,
    "cad",
    payload(start + HALF_HOUR, 101),
    start + HALF_HOUR,
  );
  assert.equal(store.readings("cad", start, start + HALF_HOUR).length, 0);
  acceptCadMessage(
    store,
    "cad",
    payload(start + HALF_HOUR + 10_000, 1),
    start + HALF_HOUR + 10_000,
  );
  assert.equal(store.anchor("cad"), undefined);
  store.close();
});
test("CAD rejects wrong units, stale duplicate messages and future timestamps", () => {
  const store = storeForCad();
  acceptCadMessage(store, "cad", payload(start, 100), start);
  assert.equal(
    acceptCadMessage(store, "cad", payload(start, 100), start).ignored,
    true,
  );
  assert.throws(
    () => acceptCadMessage(store, "cad", payload(start + 600_000, 101), start),
    /future/,
  );
  assert.throws(() =>
    acceptCadMessage(
      store,
      "cad",
      payload(start + 10_000, 101, { power: { value: 1000, units: "W" } }),
      start + 10_000,
    ),
  );
  store.close();
});
test("a real local MQTT broker delivers readings to the collector", async (t) => {
  const broker = await Aedes.createBroker(),
    server = createServer(broker.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const store = new Store(":memory:"),
    url = `mqtt://127.0.0.1:${server.address().port}`,
    topic = "glow/synthetic/SENSOR/electricitymeter";
  const collector = await collectMqtt(store, {
    broker: url,
    topic,
    stream: "mqtt-test",
  });
  const publisher = connect(url);
  await once(publisher, "connect");
  t.after(async () => {
    await publisher.endAsync();
    await collector.endAsync();
    await broker.close();
    server.close();
    store.close();
  });
  await publisher.publishAsync(topic, payload(start, 123), { qos: 1 });
  const deadline = Date.now() + 2000;
  while (!store.latestLive("mqtt-test") && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.latestLive("mqtt-test")?.cumulativeKwh, 123);
  await assert.rejects(
    collectMqtt(store, { broker: url, topic: "glow/#", stream: "bad" }),
    /wildcard/,
  );
});

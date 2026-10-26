import { connect, type MqttClient } from "mqtt";
import { z } from "zod";
import { Store } from "./store.js";
import { HALF_HOUR } from "./time.js";
import type { LiveReading } from "./types.js";

const payloadSchema = z.object({
  electricitymeter: z.object({
    timestamp: z.string().datetime({ offset: true }),
    energy: z.object({
      import: z.object({
        cumulative: z.number().nonnegative(),
        units: z.literal("kWh"),
      }),
    }),
    power: z.object({ value: z.number(), units: z.literal("kW") }),
  }),
});

export function acceptCadMessage(
  store: Store,
  stream: string,
  text: string,
  now = Date.now(),
) {
  if (Buffer.byteLength(text) > 64_000)
    throw new Error("CAD message exceeds 64 KB.");
  const meter = payloadSchema.parse(JSON.parse(text)).electricitymeter;
  const next: LiveReading = {
    stream,
    time: Date.parse(meter.timestamp),
    powerKw: meter.power.value,
    cumulativeKwh: meter.energy.import.cumulative,
  };
  if (next.time > now + 300_000)
    throw new Error(
      "CAD timestamp is more than five minutes in the future. Check its clock.",
    );
  const previous = store.latestLive(stream);
  if (previous && next.time <= previous.time)
    return { ignored: true, reason: "duplicate-or-old" };
  const gap = previous ? next.time - previous.time : Infinity;
  let createdInterval = false;
  if (!previous || gap > 60_000 || next.cumulativeKwh < previous.cumulativeKwh)
    store.clearAnchor(stream);
  else {
    const boundary = Math.ceil(previous.time / HALF_HOUR) * HALF_HOUR;
    if (boundary <= next.time) {
      const cumulative =
        previous.cumulativeKwh +
        ((next.cumulativeKwh - previous.cumulativeKwh) *
          (boundary - previous.time)) /
          gap;
      const anchor = store.anchor(stream);
      if (
        anchor &&
        boundary - anchor.time === HALF_HOUR &&
        cumulative >= anchor.cumulative
      ) {
        store.save(
          stream,
          [
            {
              start: anchor.time,
              kwh: cumulative - anchor.cumulative,
              estimated: true,
            },
          ],
          true,
        );
        createdInterval = true;
      }
      store.setAnchor(stream, boundary, cumulative);
    }
  }
  if (next.time % HALF_HOUR === 0)
    store.setAnchor(stream, next.time, next.cumulativeKwh);
  store.saveLive(next);
  return { ignored: false, createdInterval };
}

export async function collectMqtt(
  store: Store,
  options: {
    broker: string;
    topic: string;
    stream: string;
    username?: string;
    password?: string;
    onError?: (message: string) => void;
  },
): Promise<MqttClient> {
  const url = new URL(options.broker);
  if (
    !["mqtt:", "mqtts:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use an mqtt:// or mqtts:// broker URL without embedded credentials. Set MQTT_USERNAME and MQTT_PASSWORD separately.",
    );
  if (!options.topic || /[+#]/.test(options.topic))
    throw new Error(
      "Choose one exact CAD electricity topic; wildcard subscriptions could mix meters.",
    );
  store.putStream({
    id: options.stream,
    name: "Local CAD electricity",
    source: "mqtt",
  });
  const client = connect(options.broker, {
    username: options.username,
    password: options.password,
    connectTimeout: 10_000,
    reconnectPeriod: 5000,
    protocolVersion: 4,
    rejectUnauthorized: true,
    clean: true,
  });
  client.on("message", (topic, buffer) => {
    if (topic !== options.topic) return;
    try {
      acceptCadMessage(store, options.stream, buffer.toString());
    } catch {
      options.onError?.(
        "A malformed CAD message was ignored; its contents were not logged.",
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    const failed = () => {
      client.end(true);
      reject(
        new Error(
          "Could not connect to the MQTT broker. Check its address, credentials and TLS certificate.",
        ),
      );
    };
    client.once("error", failed);
    client.once("connect", () => {
      client.subscribe(options.topic, { qos: 1 }, (error) => {
        client.removeListener("error", failed);
        if (error) {
          client.end(true);
          reject(
            new Error(
              "MQTT broker refused the electricity topic subscription.",
            ),
          );
        } else resolve();
      });
    });
  });
  client.on("error", () =>
    options.onError?.(
      "MQTT connection interrupted; reconnecting. Gaps are preserved in the recorded history.",
    ),
  );
  return client;
}

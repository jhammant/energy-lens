import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Store } from "./store.js";
import { EnergyService } from "./service.js";
import { GlowClient } from "./glow.js";
import { saveCredentials, deleteCredentials } from "./credentials.js";
import { importCSV, exportCSV } from "./import.js";
import { dateRange } from "./time.js";
import { serve } from "./server.js";
import { collectMqtt } from "./mqtt.js";
import { startPowerApi } from "./power.js";

const HELP = `Energy Lens — smart-meter history and cost comparisons

  energy-lens login                         Sign in; save credentials in the OS keychain
  energy-lens logout                        Remove the saved Glow login
  energy-lens meters                        Discover verified Glow electricity meters
  energy-lens sync [--from DATE --to DATE]   Download available history (default: 13 months)
  energy-lens status                        Show cached meters and configured tariffs
  energy-lens import FILE --stream NAME     Import half-hourly CSV; preserve real zeros
  energy-lens usage --from DATE --to DATE    Show saved daily usage and coverage
  energy-lens compare --tariffs FILE --from DATE --to DATE
  energy-lens cost --tariffs FILE --tariff ID --from DATE --to DATE
  energy-lens export --from DATE --to DATE --out FILE
  energy-lens collect --broker mqtt://HOST --topic glow/DEVICE/SENSOR/electricitymeter
  energy-lens api [--stream mqtt:home]       Serve live power for HTTP / Taxi clients
  energy-lens serve                         Start the MCP stdio server

Dates are Europe/London calendar dates; --from is inclusive, --to exclusive.
Use --stream when more than one data source is saved. --mode historical requires
dated rates; default scenario applies supplied prices to the recorded usage.
Other options: --resource-id ID, --refresh, --data-dir PATH, --json,
--interval day|month|half_hour, --timezone offset|Europe/London|UTC, --baseline ID.
API options: --host 127.0.0.1, --port 18767, --stale-after 60 (seconds).
Non-loopback API access requires ENERGY_LENS_API_TOKEN and a private network/tunnel.
Credentials: extension secure settings, 'login', or GLOW_USERNAME and
GLOW_PASSWORD_FILE (private file). Never put a password in command arguments.
`;

async function passwordPrompt(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Login needs an interactive terminal. Use extension settings or a private password file for automation.",
    );
  process.stdout.write("Glow password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", input);
      process.stdout.write("\n");
    };
    const input = (buffer: Buffer) => {
      for (const char of buffer.toString()) {
        if (char === "\u0003") {
          done();
          reject(new Error("Login cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", input);
  });
}

function show(data: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const value = data as Record<string, any>;
  if (value.coverage) {
    const c = value.coverage;
    console.log(`${c.from} to ${c.toExclusive} (end exclusive, UK time)`);
    console.log(
      `Coverage: ${c.availableIntervals}/${c.expectedIntervals} half-hours (${c.coveragePercent}%). Missing: ${c.missingIntervals}.`,
    );
  }
  if (value.ranking)
    for (const row of value.ranking)
      console.log(
        `${row.tariffName}: £${row.recordedTotalGbp.toFixed(2)} — energy £${row.energyGbp.toFixed(2)}, standing £${row.standingGbp.toFixed(2)}; saving £${row.savingAgainstBaselineGbp.toFixed(2)}`,
      );
  else if (value.recordedTotalGbp !== undefined)
    console.log(
      `${value.tariffName}: £${value.recordedTotalGbp.toFixed(2)} — energy £${value.energyGbp.toFixed(2)}, standing £${value.standingGbp.toFixed(2)}.`,
    );
  else if (value.rows) {
    console.log(`Recorded use: ${value.recordedKwh} kWh`);
    for (const row of value.rows)
      console.log(
        `${row.start}: ${row.kwh === null ? "missing" : `${row.kwh} kWh`} (${row.missingIntervals} missing half-hours)`,
      );
    if (value.pagination.nextOffset !== null)
      console.log("More rows available through get_usage pagination.");
  } else if (value.streams) {
    for (const stream of value.streams)
      console.log(
        `${stream.id}: ${stream.intervals} half-hours; ${stream.recordedKwh} kWh; last reading ${stream.lastReading ?? "none"}`,
      );
    if (!value.streams.length)
      console.log("No readings saved yet. Use sync or import.");
    for (const tariff of value.tariffs)
      console.log(`Tariff: ${tariff.id} — ${tariff.name}`);
  } else if (value.meters) {
    for (const meter of value.meters)
      console.log(`${meter.resourceId} — ${meter.name} (${meter.unit})`);
    if (!value.meters.length)
      console.log("No verified electricity meter is available yet.");
  } else if (value.availableIntervals !== undefined)
    console.log(
      `Saved ${value.availableIntervals}/${value.expectedIntervals} intervals in ${value.stream}. Downloaded ${value.downloadedIntervals}; reused ${value.cachedChunks} chunks.`,
    );
  else if (value.imported !== undefined)
    console.log(
      `Imported ${value.imported} intervals into ${value.stream}; skipped ${value.skippedMissing} explicitly missing rows and ${value.duplicates} duplicates.`,
    );
  if (value.note) console.log(value.note);
  for (const warning of value.warnings ?? value.ranking?.[0]?.warnings ?? [])
    console.log(warning);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      stream: { type: "string" },
      tariffs: { type: "string" },
      tariff: { type: "string" },
      baseline: { type: "string" },
      mode: { type: "string" },
      interval: { type: "string" },
      timezone: { type: "string" },
      "data-dir": { type: "string" },
      "resource-id": { type: "string" },
      refresh: { type: "boolean" },
      out: { type: "string" },
      broker: { type: "string" },
      topic: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "stale-after": { type: "string" },
    },
  });
  const command = positionals[0] ?? "help";
  if (command === "help" || values.help) {
    console.log(HELP);
    return;
  }
  if (values["data-dir"]) process.env.ENERGY_LENS_DATA_DIR = values["data-dir"];
  if (command === "login") {
    if (!process.stdin.isTTY)
      throw new Error(
        "Run login in a terminal, or use the extension setup fields.",
      );
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const username = (await rl.question("Glow email: ")).trim();
    rl.close();
    const password = await passwordPrompt();
    if (!username || !password)
      throw new Error("Both email and password are required.");
    const credentials = { username, password };
    await new GlowClient(async () => credentials).authenticate();
    await saveCredentials(credentials);
    console.log(
      "Glow login verified and saved in the OS credential store. Run energy-lens meters, then energy-lens sync.",
    );
    return;
  }
  if (command === "logout") {
    await deleteCredentials();
    console.log("Saved Glow login removed. Cached readings remain available.");
    return;
  }
  const service = new EnergyService(
    new Store(),
    undefined,
    values.tariffs ?? process.env.ENERGY_LENS_TARIFFS,
  );
  if (command === "serve") {
    await serve(service);
    return;
  }
  if (command === "api") {
    try {
      const server = await startPowerApi(service.store, {
        host: values.host,
        port: values.port === undefined ? undefined : Number(values.port),
        stream: values.stream,
        staleAfterSeconds:
          values["stale-after"] === undefined
            ? undefined
            : Number(values["stale-after"]),
        token: process.env.ENERGY_LENS_API_TOKEN,
      });
      const address = server.address();
      console.log(
        `Read-only power API listening on ${values.host ?? "127.0.0.1"}:${typeof address === "object" ? address?.port : values.port}/v1/power. Keep the MQTT collector running.`,
      );
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        server.close(() => service.store.close());
        server.closeAllConnections();
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    } catch (error) {
      service.store.close();
      throw error;
    }
    return;
  }
  if (command === "collect") {
    const broker = values.broker ?? process.env.MQTT_BROKER,
      topic = values.topic ?? process.env.MQTT_TOPIC;
    if (!broker || !topic)
      throw new Error(
        "Provide --broker and one exact --topic, or MQTT_BROKER and MQTT_TOPIC.",
      );
    const client = await collectMqtt(service.store, {
      broker,
      topic,
      stream: values.stream ?? "mqtt:home",
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      onError: (message) => console.error(message),
    });
    console.log(
      "Collecting local CAD readings. Keep this process running. Half-hour estimates are marked and gaps remain missing.",
    );
    const close = () => {
      client.end(false, {}, () => service.store.close());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  try {
    const args = {
      from: values.from ?? "",
      to: values.to ?? "",
      stream: values.stream,
    };
    const mode = values.mode ?? "scenario";
    if (!["scenario", "historical"].includes(mode))
      throw new Error("--mode must be scenario or historical.");
    let result: unknown;
    if (command === "status") result = service.status();
    else if (command === "meters") result = { meters: await service.meters() };
    else if (command === "sync")
      result = await service.sync({
        from: values.from,
        to: values.to,
        resourceId: values["resource-id"],
        refresh: values.refresh,
      });
    else if (command === "import") {
      if (!positionals[1] || !values.stream)
        throw new Error(
          "Use import FILE --stream NAME. Each source is stored separately.",
        );
      const zone = values.timezone ?? "offset";
      if (!["offset", "Europe/London", "UTC"].includes(zone))
        throw new Error("Unsupported --timezone.");
      const imported = importCSV(
        readFileSync(positionals[1], "utf8"),
        zone as "offset" | "Europe/London" | "UTC",
      );
      service.store.putStream({
        id: values.stream,
        name: values.stream,
        source: "csv",
      });
      service.store.save(values.stream, imported.records);
      result = {
        stream: values.stream,
        imported: imported.records.length,
        duplicates: imported.duplicates,
        skippedMissing: imported.skippedMissing,
      };
    } else if (command === "usage") {
      const interval = values.interval ?? "day";
      if (!["half_hour", "day", "month"].includes(interval))
        throw new Error("Unsupported --interval.");
      result = service.usage({
        ...args,
        interval: interval as "day" | "month" | "half_hour",
      });
    } else if (command === "cost")
      result = service.cost({
        ...args,
        tariffId: values.tariff,
        mode: mode as "scenario" | "historical",
      });
    else if (command === "compare")
      result = service.compare({
        ...args,
        baselineId: values.baseline,
        mode: mode as "scenario" | "historical",
      });
    else if (command === "export") {
      if (!values.out) throw new Error("Provide --out for the CSV export.");
      const range = dateRange(args.from, args.to),
        stream = service.store.selectStream(args.stream);
      writeFileSync(
        values.out,
        exportCSV(service.store.readings(stream.id, range.start, range.end)),
        { flag: "wx", mode: 0o600 },
      );
      console.log("CSV exported.");
      return;
    } else
      throw new Error(`Unknown command: ${command}. Run energy-lens --help.`);
    show(result, values.json ?? false);
  } finally {
    service.store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Energy Lens failed.");
  process.exitCode = 1;
});

# Energy Lens connector

Download available UK smart-meter history, keep it on your computer, and compare
electricity tariffs against the same half-hourly readings. Use the CLI directly
or expose six tools to an LLM through MCP. Local CAD readings can also be
collected over MQTT and exposed through a private HTTP API with a Taxi schema.

The software is packaged locally; it has not been published to npm or the MCP
Registry. The example prices are fictional and must be replaced with your quotes.

## Build and try it

Requires Node.js 22.13 or newer. From this directory:

```bash
npm ci
npm test
npm run lint
node build/cli.mjs --help
```

The CLI examples below use `energy-lens`. Before installing a package, substitute
`node build/cli.mjs` for that command.

## Download past readings

First create a Bright/Glow account, verify your email and finish linking your
electricity meter in Bright/Glow. Account creation alone does not grant access to
meter data. The cloud route does not require buying a CAD.

```bash
energy-lens login
energy-lens meters
energy-lens sync --from 2025-10-01 --to 2026-10-01
energy-lens usage --from 2025-10-01 --to 2026-10-01 --interval month
```

`login` verifies the credentials before saving them in your OS credential store.
Passwords are never command arguments or written to the readings database. On
headless systems, use `GLOW_USERNAME` and `GLOW_PASSWORD_FILE` pointing to a private
file readable only by its owner. Linux keychain login needs a working Secret
Service. `logout` removes saved credentials without deleting readings.

Dates are **Europe/London calendar dates**, with `--from` inclusive and `--to`
exclusive. Downloads end at the start of today or earlier. Requests without dates
start on the first day of the month 13 months before the current month and end
at the start of today. This is a requested window, not a promise that Glow has all
those readings. Meter history, verification and provider availability determine
what comes back. Older ranges can be requested explicitly, up to five years per
command.

The downloader splits requests into at most ten-day chunks. Completed old chunks
can be reused for 24 hours; incomplete and recent chunks are checked again. Rerun
after an interruption to resume, or use `--refresh` to request every chunk again.
A large backfill can take longer than an MCP client's tool timeout: run it through
the CLI first, then let your LLM read the local cache.

If multiple meters are available, pass `--resource-id` from `meters`. Imported CSV,
Glow and MQTT sources have separate stream IDs so the same household is never
silently counted twice. Pass `--stream` from `status` when more than one exists.

## Import and export CSV

```bash
energy-lens import readings.csv --stream edf-import
energy-lens usage --stream edf-import --from 2026-10-17 --to 2026-10-19
energy-lens export --stream edf-import --from 2026-10-17 --to 2026-10-19 --out exported.csv
```

Use `interval_start` and `consumption_kwh` columns. `interval_end`, `ev_kwh`,
`source_energy_cost_gbp` (or `edf_energy_cost_gbp`) and `quality` are optional. Timestamps
must identify half-hour starts; explicit UTC offsets are recommended. For naive
timestamps specify `--timezone Europe/London` or `--timezone UTC`. Ambiguous UK
clock-change times are rejected. Exports refuse to overwrite an existing file.

Real zero consumption remains a reading. Only rows explicitly marked missing in
a quality/status column are skipped. If a supplier fills unavailable intervals
with zeros without marking them, clean those rows using the supplier's coverage
information before import; zero alone cannot reveal whether data is missing.
Conflicting duplicate readings are rejected. Estimated readings stay marked
through export and import.

## Compare costs

Copy `examples/tariffs.json` and replace its **fictional** prices with your quotes.
Rates are VAT-inclusive **pence** per kWh and per day; calculated costs are pounds.

```bash
energy-lens compare --stream edf-import --tariffs my-tariffs.json --baseline example-flat --from 2026-10-17 --to 2026-10-19
energy-lens cost --stream edf-import --tariffs my-tariffs.json --tariff example-flat --from 2026-10-17 --to 2026-10-19
```

Tariffs can have a flat rate or one daily off-peak window, including windows that
cross midnight. The window uses `Europe/London` unless `clock` is explicitly
`UTC`. Rate boundaries must fall on half-hours. Both UK clock-change days are
handled, with 46 or 50 intervals and one daily standing charge.

Default `scenario` mode asks what the **recorded usage** would cost at the supplied
prices. For historical bill reconstruction, provide dated `periods` as shown in
`examples/historical-tariff.json` and use `--mode historical`. Every requested date
must have exactly one applicable period; period end dates are exclusive. This
prevents silently applying today's prices to last year's bill.

Every result includes coverage and gaps. Missing consumption is never invented,
annualised or treated as free. Standing charges still cover every requested day,
including missing days. A partial result is labelled a recorded total, not a full
bill. Daily/monthly rows with no readings have `kwh: null`; comparisons with no
readings are rejected. MQTT-derived half-hours are explicitly estimated.

The tool compares unchanged whole-house consumption. It does not infer EV
charging, shift usage, validate supplier eligibility, fetch quotes, model exit
fees, or support EV-only smart-dispatch prices. Those need additional data and
rules. Optional supplier interval costs are preserved as provenance; calculations
use the tariff rates you supply and may differ from supplier rounding.

## Give an LLM access

The server runs over local stdio and exposes `meter_status`, `list_meters`,
`sync_history`, `get_usage`, `calculate_cost` and `compare_tariffs`. Only
`sync_history` downloads into the local cache. The tools cannot read arbitrary
files or change your supplier account. Meter data returned by tools is visible to
your chosen LLM host; choose a host appropriate for your household data.

Build `npm run bundle` and install `artifacts/energy-lens-0.1.0.mcpb` in an MCPB-
compatible desktop host. Enter Glow credentials in its secure setup fields,
never in the conversation. Leave both blank to analyse CSV data already imported
with the CLI. The bundle requires a compatible Node runtime supplied by the host
or installed on the machine.

For another MCP client, use an absolute path in its configuration:

```json
{
  "mcpServers": {
    "energy-lens": {
      "command": "node",
      "args": ["/absolute/path/energy-lens/connector/build/server.mjs"]
    }
  }
}
```

The normal CLI/MCP build can use credentials saved by `login`. The portable MCPB
uses its secure host settings instead of a bundled native keychain module. Put
your tariff configuration at `~/.energy-lens/tariffs.json`, or set
`ENERGY_LENS_TARIFFS` to an absolute path. Restart the server after changing it.
Inline tariff objects are also accepted by the cost tools.

Try: “Show my saved meters and coverage”, “Compare my configured tariffs for
September”, or “Which dates are missing readings?” For half-hour usage, paginate
with `offset` and `limit` (maximum 1,000 rows); totals always describe the full
requested range.

## Collect local live readings

This optional route needs a compatible Glow CAD that you own and have paired
through the supported process, with local MQTT configured. It collects future
readings; it cannot recover measurements from before the collector was running.

```bash
energy-lens collect --broker mqtt://192.168.1.20:1883 --topic glow/DEVICE/SENSOR/electricitymeter
```

Replace the broker and exact device topic with your settings. Wildcard topics are
rejected. Use `MQTT_USERNAME` and `MQTT_PASSWORD` when required, and `mqtts://` for
TLS. Keep this process on an always-on machine. Raw live samples are retained for
seven days; half-hour estimates remain in the local cache. Interpolation is
limited to samples at most 60 seconds apart. Gaps, resets and unsupported units
do not create fictional consumption.

## Live power through Taxi / Orbital

Run `energy-lens api --stream mqtt:home` alongside the MQTT collector to expose
`GET http://127.0.0.1:18767/v1/power`. The response includes watts, observation
time, reading age and an explicit live/stale/unavailable/clock-skew status. Current
watts are null when the measurement is not fresh; genuine zero remains zero.

The [Orbital example project](examples/orbital/README.md) includes semantic types,
a pinned query, private network authentication setup, and the distinction between
HTTP snapshots and a future Kafka push integration. A compatible CAD is required
for live readings; the Bright/Glow history account alone cannot supply them.

## Storage and distribution

Readings are in `~/.energy-lens/readings.sqlite` with private directory/file
permissions on Unix. Set `ENERGY_LENS_DATA_DIR` or CLI `--data-dir` to relocate it.
Use an encrypted disk where appropriate. Database files, personal tariff files,
credentials and household imports are excluded from the package and bundle.

```bash
npm run bundle
npm pack --pack-destination artifacts
npm install --global ./artifacts/jhammant-energy-lens-mcp-0.1.0.tgz
```

These commands build local artifacts and do not publish anything. `server.json`
contains proposed MCP Registry metadata; npm ownership and registry identity must
be verified before a public release. CI runs tests on Node 22/24 and
Linux/macOS/Windows when the workflow is pushed to a repository.

Build and run the container after `npm run build`:

```bash
docker build -t energy-lens:local .
docker run --rm -v energy-lens-data:/data energy-lens:local status
```

The container runs as an unprivileged user, uses `/data` for persistent readings,
and can run any CLI command. `examples/compose.yaml` runs the MQTT collector with
an automatically restarted service and a named data volume. Supply its required
broker and topic environment variables before starting it. For cloud access,
mount a private password file and set `GLOW_PASSWORD_FILE` rather than baking
credentials into an image.

## Development

Run `npm test` and `npm run lint` in this directory. From the repository root,
`npm test` also runs the dashboard calculation tests. Shared calculation code is
in `../core/engine.mjs`. Tests cover missing data, DST, dated tariffs, retries and
resumed backfills, real MCP client/server traffic, and a local MQTT broker.

Provider integration follows the [Glowmarkt API documentation](https://docs.glowmarkt.com/GlowmarktAPIDataRetrievalDocumentationIndividualUserForBright.pdf).
Packaging follows the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
and [MCPB specification](https://github.com/anthropics/mcpb).

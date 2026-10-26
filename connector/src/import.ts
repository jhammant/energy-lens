import {
  parseCSV,
  parseTimestamp,
  normalizeRecords,
} from "../../core/engine.mjs";
import { HALF_HOUR } from "./time.js";
import type { Reading } from "./types.js";

export function importCSV(
  text: string,
  zone: "offset" | "Europe/London" | "UTC" = "offset",
) {
  if (Buffer.byteLength(text) > 20_000_000)
    throw new Error("Import files must be smaller than 20 MB.");
  const parsed = parseCSV(text);
  const find = (...names: string[]) =>
    parsed.headers.findIndex((h: string) => names.includes(h.toLowerCase()));
  const startCol = find("interval_start", "start", "timestamp"),
    kwhCol = find("consumption_kwh", "kwh"),
    endCol = find("interval_end", "end"),
    evCol = find("ev_kwh"),
    costCol = find(
      "edf_energy_cost_gbp",
      "source_energy_cost_gbp",
      "energy_cost_gbp",
    ),
    statusCol = find("status", "quality");
  if (startCol < 0 || kwhCol < 0)
    throw new Error(
      "CSV needs interval_start and consumption_kwh columns. Use the cleaned EDF export; raw exports with missing-data zero placeholders need their quality information preserved.",
    );
  let skippedMissing = 0;
  const readings: Reading[] = [];
  const number = (value: string, name: string, row: number) => {
    if (
      value === undefined ||
      value.trim() === "" ||
      !Number.isFinite(Number(value))
    )
      throw new Error(`Invalid ${name} on CSV row ${row}.`);
    return Number(value);
  };
  for (const [index, row] of parsed.rows.entries()) {
    if (
      statusCol >= 0 &&
      /^(missing(?: data)?|unavailable|null)$/i.test(row[statusCol]?.trim())
    ) {
      skippedMissing++;
      continue;
    }
    const start = parseTimestamp(row[startCol], zone),
      kwh = number(row[kwhCol], "kWh", index + 2);
    if (endCol >= 0 && parseTimestamp(row[endCol], zone) - start !== HALF_HOUR)
      throw new Error(`CSV row ${index + 2} is not a half-hour interval.`);
    readings.push({
      start,
      kwh,
      ...(evCol >= 0 && row[evCol]?.trim()
        ? { ev: number(row[evCol], "EV kWh", index + 2) }
        : {}),
      ...(costCol >= 0 && row[costCol]?.trim()
        ? { sourceCostGbp: number(row[costCol], "energy cost", index + 2) }
        : {}),
      ...(statusCol >= 0 && row[statusCol]?.trim().toLowerCase() === "estimated"
        ? { estimated: true }
        : {}),
    });
  }
  const normalized = normalizeRecords(readings);
  const costs = new Map<number, number>();
  for (const r of readings)
    if (r.sourceCostGbp !== undefined) {
      if (costs.has(r.start) && costs.get(r.start) !== r.sourceCostGbp)
        throw new Error("Conflicting source costs for a duplicate interval.");
      costs.set(r.start, r.sourceCostGbp);
    }
  const estimated = new Set(
    readings.filter((r) => r.estimated).map((r) => r.start),
  );
  return {
    records: normalized.records.map((r) => ({
      start: r.start,
      kwh: r.kwh,
      ...(r.ev !== undefined ? { ev: r.ev } : {}),
      ...(costs.has(r.start) ? { sourceCostGbp: costs.get(r.start)! } : {}),
      ...(estimated.has(r.start) ? { estimated: true } : {}),
    })),
    duplicates: normalized.duplicates,
    skippedMissing,
  };
}

export function exportCSV(records: Reading[]) {
  return (
    "interval_start,interval_end,consumption_kwh,source_energy_cost_gbp,ev_kwh,quality\n" +
    records
      .map((r) =>
        [
          new Date(r.start).toISOString(),
          new Date(r.start + HALF_HOUR).toISOString(),
          r.kwh,
          r.sourceCostGbp ?? "",
          r.ev ?? "",
          r.estimated ? "estimated" : "actual",
        ].join(","),
      )
      .join("\n") +
    "\n"
  );
}

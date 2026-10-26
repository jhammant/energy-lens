import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Store, defaultDataDir } from "./store.js";
import { GlowClient, syncHistory } from "./glow.js";
import { getCredentials } from "./credentials.js";
import {
  calculateCost,
  compareCosts,
  tariffSchema,
  usage,
  type PricingMode,
} from "./analysis.js";
import { dateRange, defaultHistoryRange, localParts } from "./time.js";

export function readTariffs(path?: string) {
  if (!path) return [];
  const text = readFileSync(path, "utf8");
  if (text.length > 1_000_000)
    throw new Error("Tariff configuration must be smaller than 1 MB.");
  const parsed = JSON.parse(text);
  const inputs = Array.isArray(parsed) ? parsed : parsed.tariffs;
  if (!Array.isArray(inputs) || inputs.length > 10)
    throw new Error("Tariff file must contain an array of up to ten tariffs.");
  const tariffs = inputs.map((t) => tariffSchema.parse(t));
  if (new Set(tariffs.map((t) => t.id)).size !== tariffs.length)
    throw new Error("Configured tariff IDs must be unique.");
  return tariffs;
}

export class EnergyService {
  readonly tariffs;
  private syncing = false;
  constructor(
    readonly store = new Store(),
    readonly glow = new GlowClient(getCredentials),
    tariffFile = process.env.ENERGY_LENS_TARIFFS,
  ) {
    const defaultTariffs = join(defaultDataDir(), "tariffs.json");
    this.tariffs = readTariffs(
      tariffFile ?? (existsSync(defaultTariffs) ? defaultTariffs : undefined),
    );
  }
  status() {
    return {
      streams: this.store.streams().map((s) => {
        const summary = this.store.summary(s.id),
          live = this.store.latestLive(s.id);
        return {
          ...s,
          intervals: summary.intervals,
          recordedKwh: summary.kwh,
          firstReading:
            summary.first === null
              ? null
              : new Date(Number(summary.first)).toISOString(),
          lastReading:
            summary.last === null
              ? null
              : new Date(Number(summary.last)).toISOString(),
          ...(live
            ? {
                live: {
                  timestamp: new Date(live.time).toISOString(),
                  ageSeconds: Math.round((Date.now() - live.time) / 1000),
                  powerKw: live.powerKw,
                  cumulativeKwh: live.cumulativeKwh,
                },
              }
            : {}),
        };
      }),
      tariffs: this.tariffs.map((t) => ({
        id: t.id,
        name: t.name,
        dated: !!t.periods,
        checkedOn: t.checkedOn,
      })),
      defaultHistoryRange: defaultHistoryRange(),
      note: "Dates use Europe/London; range ends are exclusive. Glow data may be delayed. Streams remain separate to avoid counting the same meter twice.",
    };
  }
  async meters(signal?: AbortSignal) {
    return (await this.glow.resources(signal))
      .filter(
        (r) =>
          r.classifier === "electricity.consumption" &&
          r.baseUnit.toLowerCase() === "kwh",
      )
      .map((r) => ({
        resourceId: r.resourceId,
        name: r.entityName,
        unit: r.baseUnit,
      }));
  }
  async sync(
    args: {
      from?: string;
      to?: string;
      resourceId?: string;
      refresh?: boolean;
    },
    signal?: AbortSignal,
  ) {
    if (this.syncing)
      throw new Error(
        "A history download is already running. Wait for it to finish before starting another.",
      );
    const defaults = defaultHistoryRange(),
      range = dateRange(args.from ?? defaults.from, args.to ?? defaults.to);
    if (range.to > localParts(Date.now()).date)
      throw new Error(
        "Historical downloads end at the start of today or earlier; the end date is exclusive.",
      );
    this.syncing = true;
    try {
      return await syncHistory(this.store, this.glow, range, {
        resourceId: args.resourceId,
        refresh: args.refresh,
        signal,
      });
    } finally {
      this.syncing = false;
    }
  }
  private selection(args: { from: string; to: string; stream?: string }) {
    const stream = this.store.selectStream(args.stream),
      range = dateRange(args.from, args.to);
    return {
      stream: stream.id,
      range,
      records: this.store.readings(stream.id, range.start, range.end),
    };
  }
  usage(args: {
    from: string;
    to: string;
    stream?: string;
    interval?: "half_hour" | "day" | "month";
    offset?: number;
    limit?: number;
  }) {
    const { stream, range, records } = this.selection(args);
    return {
      stream,
      ...usage(records, range, args.interval, args.offset, args.limit),
    };
  }
  cost(args: {
    from: string;
    to: string;
    stream?: string;
    tariff?: unknown;
    tariffId?: string;
    mode?: PricingMode;
  }) {
    const { stream, range, records } = this.selection(args);
    const tariff =
      args.tariff ?? this.tariffs.find((t) => t.id === args.tariffId);
    if (!tariff)
      throw new Error(
        "Supply a tariff with VAT-inclusive rates, or a configured tariffId shown in meter_status.",
      );
    return { stream, ...calculateCost(records, range, tariff, args.mode) };
  }
  compare(args: {
    from: string;
    to: string;
    stream?: string;
    tariffs?: unknown[];
    baselineId?: string;
    mode?: PricingMode;
  }) {
    const { stream, range, records } = this.selection(args);
    return {
      stream,
      ...compareCosts(
        records,
        range,
        args.tariffs ?? this.tariffs,
        args.baselineId,
        args.mode,
      ),
    };
  }
}

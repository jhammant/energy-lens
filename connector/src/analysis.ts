import { z } from "zod";
import {
  normalizeRecords,
  priceRecords,
  inWindow,
} from "../../core/engine.mjs";
import {
  dates,
  dateOnly,
  HALF_HOUR,
  localParts,
  midnight,
  round,
  type DateRange,
} from "./time.js";
import type { Reading } from "./types.js";

const clockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[03]0$/);
const rateSchema = z
  .object({
    unitPencePerKwh: z.number().min(0).max(1000),
    standingPencePerDay: z.number().min(0).max(1000),
    offPeak: z
      .object({
        start: clockSchema,
        end: clockSchema,
        unitPencePerKwh: z.number().min(0).max(1000),
        clock: z.enum(["Europe/London", "UTC"]).default("Europe/London"),
      })
      .strict()
      .optional(),
  })
  .strict();
export const tariffSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    name: z.string().min(1).max(160),
    currency: z.literal("GBP").default("GBP"),
    vatIncluded: z.literal(true),
    rates: rateSchema.optional(),
    periods: z
      .array(
        rateSchema
          .extend({ from: z.string(), to: z.string().optional() })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
    source: z.string().max(1000).optional(),
    checkedOn: z.string().optional(),
  })
  .strict()
  .superRefine((tariff, ctx) => {
    if (Boolean(tariff.rates) === Boolean(tariff.periods))
      ctx.addIssue({
        code: "custom",
        message:
          "Provide either constant scenario rates or dated tariff periods, not both.",
      });
    for (const rate of [tariff.rates, ...(tariff.periods ?? [])])
      if (rate?.offPeak?.start === rate?.offPeak?.end && rate?.offPeak)
        ctx.addIssue({
          code: "custom",
          message: "Off-peak start and end must differ.",
        });
  });
export type Tariff = z.infer<typeof tariffSchema>;
type Rates = z.infer<typeof rateSchema>;
export type PricingMode = "scenario" | "historical";

export function coverage(records: Reading[], range: DateRange) {
  const starts = new Set(records.map((r) => r.start));
  const gaps: { from: string; toExclusive: string; intervals: number }[] = [];
  let missing = 0,
    gapStart: number | undefined;
  for (let time = range.start; time <= range.end; time += HALF_HOUR) {
    const absent = time < range.end && !starts.has(time);
    if (absent) {
      missing++;
      gapStart ??= time;
    } else if (gapStart !== undefined) {
      gaps.push({
        from: new Date(gapStart).toISOString(),
        toExclusive: new Date(time).toISOString(),
        intervals: (time - gapStart) / HALF_HOUR,
      });
      gapStart = undefined;
    }
  }
  return {
    from: range.from,
    toExclusive: range.to,
    timezone: "Europe/London",
    estimatedIntervals: records.filter((r) => r.estimated).length,
    expectedIntervals: range.expected,
    availableIntervals: records.length,
    missingIntervals: missing,
    complete: missing === 0,
    coveragePercent: round((100 * records.length) / range.expected, 2),
    firstReading: records.length
      ? new Date(records[0].start).toISOString()
      : null,
    lastReading: records.length
      ? new Date(records.at(-1)!.start).toISOString()
      : null,
    gaps: gaps.slice(0, 20),
    additionalGapCount: Math.max(0, gaps.length - 20),
  };
}

export function usage(
  records: Reading[],
  range: DateRange,
  interval: "half_hour" | "day" | "month" = "day",
  offset = 0,
  limit = 100,
) {
  if (offset < 0 || limit < 1 || limit > 1000)
    throw new Error(
      "Choose an offset of zero or more and a page size between 1 and 1,000.",
    );
  const groups = new Map<
    string,
    { start: string; kwh: number; intervals: number; expectedIntervals: number }
  >();
  if (interval !== "half_hour")
    for (const day of dates(range)) {
      const key = interval === "month" ? day.slice(0, 7) : day;
      const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const entry = groups.get(key) ?? {
        start: key,
        kwh: 0,
        intervals: 0,
        expectedIntervals: 0,
      };
      entry.expectedIntervals += (midnight(next) - midnight(day)) / HALF_HOUR;
      groups.set(key, entry);
    }
  for (const r of records) {
    const day = localParts(r.start).date,
      key =
        interval === "half_hour"
          ? new Date(r.start).toISOString()
          : interval === "month"
            ? day.slice(0, 7)
            : day;
    const entry = groups.get(key) ?? {
      start: key,
      kwh: 0,
      intervals: 0,
      expectedIntervals: 1,
    };
    entry.kwh += r.kwh;
    entry.intervals++;
    groups.set(key, entry);
  }
  const allRows = [...groups.values()].map((r) => ({
    ...r,
    kwh: r.intervals ? round(r.kwh) : null,
    missingIntervals: r.expectedIntervals - r.intervals,
  }));
  return {
    coverage: coverage(records, range),
    recordedKwh: round(records.reduce((sum, r) => sum + r.kwh, 0)),
    interval,
    rows: allRows.slice(offset, offset + limit),
    pagination: {
      offset,
      limit,
      total: allRows.length,
      nextOffset: offset + limit < allRows.length ? offset + limit : null,
    },
    note: "Missing intervals are not zero and no usage is extrapolated. Half-hour rows show recorded intervals only; daily/monthly rows include missing days.",
  };
}

function validatePeriods(tariff: Tariff) {
  const periods = [...(tariff.periods ?? [])].sort((a, b) =>
    a.from.localeCompare(b.from),
  );
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    dateOnly(p.from);
    if (p.to) {
      dateOnly(p.to);
      if (p.to <= p.from)
        throw new Error("A tariff period end must follow its start.");
    }
    if (i && (!periods[i - 1].to || periods[i - 1].to! > p.from))
      throw new Error(
        "Tariff periods overlap. Use non-overlapping effective dates.",
      );
  }
  return periods;
}

export function calculateCost(
  records: Reading[],
  range: DateRange,
  input: unknown,
  mode: PricingMode = "scenario",
) {
  const tariff = tariffSchema.parse(input),
    periods = validatePeriods(tariff);
  if (mode === "historical" && !periods.length)
    throw new Error(
      "Historical cost requires dated tariff periods covering the full requested range. Constant rates are for scenario comparisons.",
    );
  const ratesByDay = new Map<string, Rates>();
  for (const date of dates(range)) {
    const rate =
      tariff.rates ??
      periods.find((p) => p.from <= date && (!p.to || date < p.to));
    if (!rate)
      throw new Error(
        `Tariff ${tariff.id} has no rate for ${date}. Add the missing historical rate or use a constant-rate scenario.`,
      );
    ratesByDay.set(date, rate);
  }
  const normal = normalizeRecords(records).records;
  const grouped = new Map<Rates, typeof normal>();
  for (const r of normal) {
    const rate = ratesByDay.get(r.date);
    if (!rate) throw new Error("A reading falls outside the requested range.");
    const group = grouped.get(rate) ?? [];
    const minute =
      rate.offPeak?.clock === "UTC"
        ? new Date(r.start).getUTCHours() * 60 +
          new Date(r.start).getUTCMinutes()
        : r.minute;
    group.push({ ...r, minute });
    grouped.set(rate, group);
  }
  let energy = 0,
    offPeakKwh = 0;
  const minutes = (clock: string) =>
    Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  for (const [rate, group] of grouped) {
    const legacy = {
      type: rate.offPeak ? "tou" : "flat",
      day: rate.unitPencePerKwh,
      night: rate.offPeak?.unitPencePerKwh ?? null,
      standing: 0,
      start: rate.offPeak ? minutes(rate.offPeak.start) : 0,
      end: rate.offPeak ? minutes(rate.offPeak.end) : 0,
    };
    const cost = priceRecords(group, legacy, 0)!;
    energy += cost.energy;
    if (rate.offPeak)
      offPeakKwh += group
        .filter((r) => inWindow(r.minute, legacy.start, legacy.end))
        .reduce((total, r) => total + r.kwh, 0);
  }
  const standing = [...ratesByDay.values()].reduce(
    (sum, r) => sum + r.standingPencePerDay / 100,
    0,
  );
  const quality = coverage(records, range);
  const warnings = [
    mode === "scenario"
      ? "Scenario: these prices are reapplied to recorded usage; this is not a reconstruction of a past bill."
      : "Historical estimate uses the supplied dated rates; supplier invoice rounding and adjustments may differ.",
  ];
  if (!quality.complete)
    warnings.push(
      "Energy cost covers recorded intervals only. Missing usage is unknown; standing charges cover every requested calendar day.",
    );
  if (quality.estimatedIntervals)
    warnings.push(
      "Includes local CAD intervals estimated from cumulative readings at half-hour boundaries. These are not supplier settlement readings.",
    );
  if (!records.length)
    warnings.push(
      "No consumption readings exist for this range. The returned total contains standing charges only and cannot be used to rank tariffs.",
    );
  return {
    tariffId: tariff.id,
    tariffName: tariff.name,
    mode,
    currency: "GBP",
    vatIncluded: true,
    coverage: quality,
    recordedKwh: round(records.reduce((sum, r) => sum + r.kwh, 0)),
    offPeakKwh: round(offPeakKwh),
    energyGbp: round(energy),
    standingGbp: round(standing),
    recordedTotalGbp: round(energy + standing),
    standingChargeDays: range.days,
    ratesUsed: tariff,
    warnings,
  };
}

export function compareCosts(
  records: Reading[],
  range: DateRange,
  inputs: unknown[],
  baselineId?: string,
  mode: PricingMode = "scenario",
) {
  if (!records.length)
    throw new Error(
      "There are no readings in this range. Download or import data before comparing costs.",
    );
  if (inputs.length < 2 || inputs.length > 10)
    throw new Error("Compare between two and ten tariffs.");
  const costs = inputs.map((input) =>
    calculateCost(records, range, input, mode),
  );
  if (new Set(costs.map((c) => c.tariffId)).size !== costs.length)
    throw new Error("Each tariff must have a unique ID.");
  const baseline = baselineId
    ? costs.find((c) => c.tariffId === baselineId)
    : costs[0];
  if (!baseline)
    throw new Error("The baseline tariff ID is not in the comparison.");
  return {
    baselineId: baseline.tariffId,
    mode,
    coverage: coverage(records, range),
    ranking: costs
      .map((c) => ({
        ...c,
        savingAgainstBaselineGbp: round(
          baseline.recordedTotalGbp - c.recordedTotalGbp,
        ),
      }))
      .sort((a, b) => a.recordedTotalGbp - b.recordedTotalGbp),
    note: "Same recorded consumption and date range for every tariff. No annual extrapolation, EV rescheduling, eligibility assessment, exit fees, incentives or future rate forecast.",
  };
}

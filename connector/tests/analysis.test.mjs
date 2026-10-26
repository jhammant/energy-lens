import test from "node:test";
import assert from "node:assert/strict";
import {
  dateRange,
  HALF_HOUR,
  calculateCost,
  compareCosts,
  usage,
  importCSV,
  exportCSV,
  Store,
} from "../build/api.mjs";

const flat = {
  id: "flat",
  name: "Flat",
  vatIncluded: true,
  rates: { unitPencePerKwh: 25, standingPencePerDay: 40 },
};
const night = {
  id: "night",
  name: "Night",
  vatIncluded: true,
  rates: {
    unitPencePerKwh: 30,
    standingPencePerDay: 45,
    offPeak: {
      start: "23:00",
      end: "06:00",
      unitPencePerKwh: 7,
      clock: "Europe/London",
    },
  },
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const rows = (range, kwh = 1) =>
  Array.from({ length: range.expected }, (_, i) => ({
    start: range.start + i * HALF_HOUR,
    kwh,
  }));

test("UK clock changes retain 46/50 intervals and one standing charge", () => {
  for (const [from, to, count] of [
    ["2026-03-29", "2026-03-30", 46],
    ["2026-10-25", "2026-10-26", 50],
  ]) {
    const range = dateRange(from, to),
      cost = calculateCost(rows(range), range, flat);
    assert.equal(range.expected, count);
    assert.equal(cost.coverage.complete, true);
    near(cost.standingGbp, 0.4);
    near(cost.energyGbp, count * 0.25);
  }
});
test("real zeros count as present; missing entire days stay null", () => {
  const range = dateRange("2026-10-01", "2026-10-03");
  const result = usage([{ start: range.start, kwh: 0 }], range);
  assert.equal(result.coverage.availableIntervals, 1);
  assert.equal(result.coverage.missingIntervals, 95);
  assert.equal(result.rows[0].kwh, 0);
  assert.equal(result.rows[1].kwh, null);
  assert.equal(result.rows[1].missingIntervals, 48);
  assert.equal(
    calculateCost([{ start: range.start, kwh: 0 }], range, flat).standingGbp,
    0.8,
  );
});
test("overnight rate crosses midnight and uses UK local clock during summer", () => {
  const range = dateRange("2026-07-01", "2026-07-02");
  const result = calculateCost(rows(range), range, night);
  near(result.offPeakKwh, 14);
  near(result.energyGbp, 14 * 0.07 + 34 * 0.3);
});
test("UTC tariffs use UTC windows and equal rates do not misclassify all usage as off-peak", () => {
  const range = dateRange("2026-07-01", "2026-07-02");
  const records = [
    { start: Date.parse("2026-07-01T05:30:00Z"), kwh: 1 },
    { start: Date.parse("2026-07-01T22:00:00Z"), kwh: 2 },
  ];
  const utc = {
    ...night,
    rates: {
      ...night.rates,
      offPeak: { ...night.rates.offPeak, clock: "UTC" },
    },
  };
  near(calculateCost(records, range, night).energyGbp, 0.44);
  near(calculateCost(records, range, utc).energyGbp, 0.67);
  const equal = {
    ...night,
    rates: {
      ...night.rates,
      offPeak: { ...night.rates.offPeak, unitPencePerKwh: 30 },
    },
  };
  near(calculateCost(rows(range), range, equal).offPeakKwh, 14);
});
test("historical rates change on effective date including standing charges on missing days", () => {
  const range = dateRange("2026-03-31", "2026-04-02");
  const tariff = {
    id: "dated",
    name: "Dated",
    vatIncluded: true,
    periods: [
      {
        from: "2026-01-01",
        to: "2026-04-01",
        unitPencePerKwh: 20,
        standingPencePerDay: 40,
      },
      { from: "2026-04-01", unitPencePerKwh: 30, standingPencePerDay: 50 },
    ],
  };
  const cost = calculateCost(rows(range), range, tariff, "historical");
  near(cost.energyGbp, 24);
  near(cost.standingGbp, 0.9);
  const missing = calculateCost(
    rows(range).slice(0, 48),
    range,
    tariff,
    "historical",
  );
  near(missing.energyGbp, 9.6);
  near(missing.standingGbp, 0.9);
});
test("historical calculations reject undated, missing or overlapping rates", () => {
  const range = dateRange("2026-01-01", "2026-01-02");
  assert.throws(
    () => calculateCost(rows(range), range, flat, "historical"),
    /dated/,
  );
  const period = {
    from: "2026-01-02",
    unitPencePerKwh: 20,
    standingPencePerDay: 40,
  };
  assert.throws(
    () =>
      calculateCost(
        rows(range),
        range,
        { id: "x", name: "X", vatIncluded: true, periods: [period] },
        "historical",
      ),
    /no rate/,
  );
  assert.throws(
    () =>
      calculateCost(
        rows(range),
        range,
        {
          id: "x",
          name: "X",
          vatIncluded: true,
          periods: [{ ...period, from: "2026-01-01" }, period],
        },
        "historical",
      ),
    /overlap/,
  );
});
test("comparison uses identical recorded usage and refuses empty data or duplicate IDs", () => {
  const range = dateRange("2026-07-01", "2026-07-03"),
    records = rows(range).slice(0, 48);
  const result = compareCosts(records, range, [flat, night]);
  assert.equal(result.coverage.coveragePercent, 50);
  assert.equal(
    result.ranking.every((c) => c.recordedKwh === 48),
    true,
  );
  assert.throws(() => compareCosts([], range, [flat, night]), /no readings/);
  assert.throws(() => compareCosts(records, range, [flat, flat]), /unique/);
});
test("CSV preserves costs, estimates and real zeros across export/import", () => {
  const range = dateRange("2026-10-17", "2026-10-18"),
    records = [
      { start: range.start, kwh: 0, sourceCostGbp: 0 },
      {
        start: range.start + HALF_HOUR,
        kwh: 1.23,
        sourceCostGbp: 0.4321,
        estimated: true,
      },
    ];
  assert.deepEqual(importCSV(exportCSV(records)).records, records);
});
test("CSV skips only explicitly missing rows and rejects ambiguous local clocks", () => {
  const result = importCSV(
    "interval_start,consumption_kwh,status\n2026-10-17T00:00:00Z,0,actual\n2026-10-17T00:30:00Z,0,missing data\n",
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].kwh, 0);
  assert.equal(result.skippedMissing, 1);
  assert.throws(
    () =>
      importCSV(
        "interval_start,consumption_kwh\n2026-10-25 01:30,1",
        "Europe/London",
      ),
    /Ambiguous/,
  );
  assert.throws(
    () => importCSV("interval_start,consumption_kwh\n2026-10-25T00:00:00Z,\n"),
    /Invalid/,
  );
});
test("store transactions roll back conflicting imports, and separate sources need explicit selection", () => {
  const store = new Store(":memory:");
  store.putStream({ id: "one", name: "One", source: "csv" });
  store.save("one", [{ start: 0, kwh: 1 }]);
  assert.throws(
    () =>
      store.save("one", [
        { start: HALF_HOUR, kwh: 2 },
        { start: 0, kwh: 3 },
      ]),
    /Conflicting/,
  );
  assert.equal(store.readings("one", 0, HALF_HOUR * 2).length, 1);
  store.putStream({ id: "two", name: "Two", source: "csv" });
  assert.throws(() => store.selectStream(), /Specify/);
  store.close();
});
test("pagination limits rows without changing full-range totals", () => {
  const range = dateRange("2026-01-01", "2026-01-03"),
    records = rows(range);
  const result = usage(records, range, "half_hour", 5, 10);
  assert.equal(result.recordedKwh, 96);
  assert.equal(result.rows.length, 10);
  assert.equal(result.pagination.nextOffset, 15);
});
test("invalid dates and unbounded history requests fail", () => {
  for (const [a, b] of [
    ["2026-02-30", "2026-03-02"],
    ["2026-01-02", "2026-01-01"],
    ["2020-01-01", "2026-01-01"],
  ])
    assert.throws(() => dateRange(a, b));
});

import { addDate, localParts, midnight } from "../../core/engine.mjs";

export const HALF_HOUR = 1_800_000;
export const DAY = 86_400_000;
export type DateRange = {
  from: string;
  to: string;
  start: number;
  end: number;
  days: number;
  expected: number;
};

export function dateOnly(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Dates must be real calendar dates in YYYY-MM-DD format.");
  }
  return value;
}

export function dateRange(from: string, to: string): DateRange {
  dateOnly(from);
  dateOnly(to);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY);
  if (days < 1 || days > 1827)
    throw new Error(
      "Choose a range of 1 to 1,827 days; the end date is exclusive.",
    );
  const start = midnight(from),
    end = midnight(to);
  return { from, to, start, end, days, expected: (end - start) / HALF_HOUR };
}

export function defaultHistoryRange(now = Date.now()): DateRange {
  const to = localParts(now).date;
  const month = new Date(`${to.slice(0, 7)}-01T12:00:00Z`);
  month.setUTCMonth(month.getUTCMonth() - 13);
  return dateRange(month.toISOString().slice(0, 10), to);
}

export function* dates(range: DateRange) {
  for (let day = range.from; day < range.to; day = addDate(day, 1)) yield day;
}

export const round = (value: number, places = 6) =>
  Number(value.toFixed(places));
export { addDate, localParts, midnight };

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { HALF_HOUR } from "./time.js";
import type { Reading, Stream, LiveReading } from "./types.js";

export const defaultDataDir = () =>
  process.env.ENERGY_LENS_DATA_DIR || join(homedir(), ".energy-lens");

export class Store {
  private db: DatabaseSync;
  constructor(public path = join(defaultDataDir(), "readings.sqlite")) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, resource_id TEXT, last_sync TEXT);
      CREATE TABLE IF NOT EXISTS readings(stream TEXT NOT NULL REFERENCES streams(id), start INTEGER NOT NULL, kwh REAL NOT NULL CHECK(kwh>=0), source_cost REAL, ev REAL, estimated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(stream,start));
      CREATE TABLE IF NOT EXISTS sync_chunks(stream TEXT NOT NULL REFERENCES streams(id), start INTEGER NOT NULL, end INTEGER NOT NULL, checked TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(stream,start,end));
      CREATE TABLE IF NOT EXISTS live(stream TEXT NOT NULL REFERENCES streams(id), time INTEGER NOT NULL, power REAL NOT NULL, cumulative REAL NOT NULL, PRIMARY KEY(stream,time));
      CREATE TABLE IF NOT EXISTS anchors(stream TEXT PRIMARY KEY REFERENCES streams(id), time INTEGER NOT NULL, cumulative REAL NOT NULL);`);
    const columns = this.db.prepare("PRAGMA table_info(readings)").all();
    if (!columns.some((c) => c.name === "estimated"))
      this.db.exec(
        "ALTER TABLE readings ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0",
      );
  }
  close() {
    this.db.close();
  }
  streams(): Stream[] {
    return this.db
      .prepare(
        "SELECT id,name,source,resource_id AS resourceId,last_sync AS lastSync FROM streams ORDER BY id",
      )
      .all() as Stream[];
  }
  putStream(stream: Stream) {
    const previous = this.streams().find((s) => s.id === stream.id);
    if (
      previous &&
      (previous.source !== stream.source ||
        (previous.resourceId ?? null) !== (stream.resourceId ?? null))
    )
      throw new Error(
        "This stream name already belongs to a different source. Choose another stream ID.",
      );
    this.db
      .prepare(
        "INSERT INTO streams(id,name,source,resource_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
      )
      .run(stream.id, stream.name, stream.source, stream.resourceId ?? null);
  }
  selectStream(id?: string): Stream {
    const streams = this.streams();
    const stream = id
      ? streams.find((s) => s.id === id)
      : streams.length === 1
        ? streams[0]
        : undefined;
    if (!stream)
      throw new Error(
        streams.length
          ? "Specify a stream ID from meter_status; sources are never combined automatically."
          : "No readings yet. Run sync_history with a verified Glow account, or import a CSV.",
      );
    return stream;
  }
  save(id: string, records: Reading[], replace = false) {
    this.selectStream(id);
    const insert = this.db.prepare(
      `INSERT INTO readings(stream,start,kwh,source_cost,ev,estimated) VALUES(?,?,?,?,?,?) ON CONFLICT(stream,start) DO UPDATE SET kwh=excluded.kwh,source_cost=COALESCE(excluded.source_cost,readings.source_cost),ev=COALESCE(excluded.ev,readings.ev),estimated=excluded.estimated`,
    );
    const existing = this.db.prepare(
      "SELECT kwh,ev FROM readings WHERE stream=? AND start=?",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of records) {
        if (
          !Number.isFinite(r.start) ||
          r.start % HALF_HOUR !== 0 ||
          !Number.isFinite(r.kwh) ||
          r.kwh < 0 ||
          (r.ev !== undefined &&
            (!Number.isFinite(r.ev) || r.ev < 0 || r.ev > r.kwh)) ||
          (r.sourceCostGbp !== undefined && !Number.isFinite(r.sourceCostGbp))
        )
          throw new Error(
            "Invalid half-hourly reading. No rows from this batch were saved.",
          );
        const prior = existing.get(id, r.start);
        if (
          prior &&
          !replace &&
          (Math.abs(Number(prior.kwh) - r.kwh) > 1e-9 ||
            (prior.ev ?? null) !== (r.ev ?? null))
        )
          throw new Error(
            "Conflicting readings in this stream. Import into a separate stream or explicitly replace the source data.",
          );
        insert.run(
          id,
          r.start,
          r.kwh,
          r.sourceCostGbp ?? null,
          r.ev ?? null,
          r.estimated ? 1 : 0,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  readings(id: string, start: number, end: number): Reading[] {
    return this.db
      .prepare(
        "SELECT start,kwh,source_cost AS sourceCostGbp,ev,estimated FROM readings WHERE stream=? AND start>=? AND start<? ORDER BY start",
      )
      .all(id, start, end)
      .map((row) => ({
        start: Number(row.start),
        kwh: Number(row.kwh),
        ...(row.sourceCostGbp !== null
          ? { sourceCostGbp: Number(row.sourceCostGbp) }
          : {}),
        ...(row.ev !== null ? { ev: Number(row.ev) } : {}),
        ...(row.estimated ? { estimated: true } : {}),
      }));
  }
  summary(id: string) {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS intervals, MIN(start) AS first, MAX(start) AS last, COALESCE(SUM(kwh),0) AS kwh FROM readings WHERE stream=?",
      )
      .get(id)!;
  }
  checkedChunk(id: string, start: number, end: number) {
    return this.db
      .prepare(
        "SELECT checked,count FROM sync_chunks WHERE stream=? AND start=? AND end=?",
      )
      .get(id, start, end);
  }
  markChunk(
    id: string,
    start: number,
    end: number,
    count: number,
    now = Date.now(),
  ) {
    const checked = new Date(now).toISOString();
    this.db
      .prepare(
        "INSERT INTO sync_chunks VALUES(?,?,?,?,?) ON CONFLICT(stream,start,end) DO UPDATE SET checked=excluded.checked,count=excluded.count",
      )
      .run(id, start, end, checked, count);
    this.db
      .prepare("UPDATE streams SET last_sync=? WHERE id=?")
      .run(checked, id);
  }
  saveLive(r: LiveReading) {
    this.db
      .prepare("INSERT OR IGNORE INTO live VALUES(?,?,?,?)")
      .run(r.stream, r.time, r.powerKw, r.cumulativeKwh);
    // Bound high-frequency storage; half-hour history is retained independently.
    this.db
      .prepare("DELETE FROM live WHERE stream=? AND time<?")
      .run(r.stream, r.time - 7 * 86_400_000);
  }
  latestLive(id: string): LiveReading | undefined {
    return this.db
      .prepare(
        "SELECT stream,time,power AS powerKw,cumulative AS cumulativeKwh FROM live WHERE stream=? ORDER BY time DESC LIMIT 1",
      )
      .get(id) as LiveReading | undefined;
  }
  anchor(id: string) {
    return this.db
      .prepare("SELECT time,cumulative FROM anchors WHERE stream=?")
      .get(id) as { time: number; cumulative: number } | undefined;
  }
  setAnchor(id: string, time: number, cumulative: number) {
    this.db
      .prepare(
        "INSERT INTO anchors VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET time=excluded.time,cumulative=excluded.cumulative",
      )
      .run(id, time, cumulative);
  }
  clearAnchor(id: string) {
    this.db.prepare("DELETE FROM anchors WHERE stream=?").run(id);
  }
}

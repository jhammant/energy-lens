import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { DAY, HALF_HOUR, type DateRange } from "./time.js";
import type { Credentials } from "./credentials.js";
import type { Reading, Stream } from "./types.js";
import { Store } from "./store.js";

const API = "https://api.glowmarkt.com/api/v0-1";
const APPLICATION = "b0f1b774-a586-4f72-9edd-27ead8aa7a8d";
const resourceSchema = z.object({
  resourceId: z.string().min(1),
  classifier: z.string(),
  baseUnit: z.string(),
  name: z.string().optional(),
  active: z.boolean().optional(),
});
export type Resource = z.infer<typeof resourceSchema> & { entityName: string };
type Fetch = typeof globalThis.fetch;

export class GlowClient {
  private token?: string;
  private expires = 0;
  constructor(
    private credentials: () => Promise<Credentials>,
    private request: Fetch = globalThis.fetch,
    private delay = (ms: number) => sleep(ms),
  ) {}

  private async http(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(20_000);
        response = await this.request(`${API}${path}`, {
          ...init,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          redirect: "error",
        });
      } catch {
        signal?.throwIfAborted();
        throw new Error(
          "Glow could not be reached within 20 seconds. Saved readings are still available; retry the download later.",
        );
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get("retry-after"));
        const delay = Math.min(
          30_000,
          Math.max(
            1000,
            Number.isFinite(retry) && retry > 0
              ? retry * 1000
              : 1000 * 2 ** attempt,
          ),
        );
        await response.body?.cancel();
        await this.delay(delay);
        continue;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        throw new GlowAuthError();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Glow request failed (HTTP ${response.status}). No credentials or response body were logged.`,
        );
      }
      const text = await response.text();
      if (text.length > 2_000_000)
        throw new Error("Glow returned an unexpectedly large response.");
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("Glow returned an invalid JSON response.");
      }
    }
    throw new Error("Glow is busy. Please retry later.");
  }

  async authenticate(force = false, signal?: AbortSignal) {
    if (!force && this.token && this.expires > Date.now() + 60_000) return;
    const credentials = await this.credentials();
    const response = z
      .object({
        valid: z.boolean().optional(),
        token: z.string().min(1),
        exp: z.number().optional(),
      })
      .safeParse(
        await this.http(
          "/auth",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              applicationId: APPLICATION,
            },
            body: JSON.stringify(credentials),
          },
          signal,
        ),
      );
    if (!response.success || response.data.valid === false)
      throw new GlowAuthError();
    this.token = response.data.token;
    this.expires = response.data.exp
      ? response.data.exp * 1000
      : Date.now() + DAY;
  }

  private async get(path: string, signal?: AbortSignal) {
    await this.authenticate(false, signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.http(
          path,
          { headers: { token: this.token!, applicationId: APPLICATION } },
          signal,
        );
      } catch (error) {
        if (!(error instanceof GlowAuthError) || attempt === 1) throw error;
        await this.authenticate(true, signal);
      }
    }
    throw new GlowAuthError();
  }

  async resources(signal?: AbortSignal): Promise<Resource[]> {
    const entities = z
      .array(z.object({ veId: z.string().min(1), name: z.string().optional() }))
      .parse(await this.get("/virtualentity", signal));
    const result: Resource[] = [];
    for (const entity of entities) {
      const body = z
        .object({ resources: z.array(resourceSchema) })
        .parse(
          await this.get(
            `/virtualentity/${encodeURIComponent(entity.veId)}/resources`,
            signal,
          ),
        );
      for (const resource of body.resources)
        if (resource.active !== false)
          result.push({ ...resource, entityName: entity.name ?? "Home" });
    }
    return result;
  }

  async readings(
    resource: Resource,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Reading[]> {
    if (
      resource.classifier !== "electricity.consumption" ||
      resource.baseUnit.toLowerCase() !== "kwh"
    )
      throw new Error(
        "Choose an electricity.consumption resource measured in kWh. Cost and cumulative resources cannot be used as consumption.",
      );
    if (end <= start || end - start > 10 * DAY)
      throw new Error(
        "A half-hourly Glow request must cover at most ten days.",
      );
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
    const query = new URLSearchParams({
      from: iso(start),
      to: iso(end - 1000),
      period: "PT30M",
      offset: "0",
      function: "sum",
    });
    const response = z
      .object({
        status: z.string().optional(),
        data: z.array(z.tuple([z.number(), z.number().nullable()])),
      })
      .parse(
        await this.get(
          `/resource/${encodeURIComponent(resource.resourceId)}/readings?${query}`,
          signal,
        ),
      );
    if (response.status && response.status !== "OK")
      throw new Error(
        "Glow did not report a successful data response. This chunk has not been marked complete.",
      );
    const records = new Map<number, Reading>();
    for (const [seconds, kwh] of response.data) {
      const startMs = seconds * 1000;
      if (startMs < start || startMs >= end) continue;
      if (kwh === null) continue;
      if (!Number.isFinite(kwh) || kwh < 0 || startMs % HALF_HOUR !== 0)
        throw new Error(
          "Glow returned an invalid consumption interval. This chunk was not saved.",
        );
      if (records.has(startMs) && records.get(startMs)!.kwh !== kwh)
        throw new Error("Glow returned conflicting duplicate intervals.");
      records.set(startMs, { start: startMs, kwh });
    }
    return [...records.values()].sort((a, b) => a.start - b.start);
  }
}

class GlowAuthError extends Error {
  constructor() {
    super(
      "Glow sign-in failed or expired. Check your login and email verification in Bright/Glow; then retry.",
    );
  }
}

export async function syncHistory(
  store: Store,
  client: GlowClient,
  range: DateRange,
  options: {
    resourceId?: string;
    refresh?: boolean;
    now?: number;
    signal?: AbortSignal;
    progress?: (done: number, total: number) => void;
    delayMs?: number;
  } = {},
) {
  const resources = (await client.resources(options.signal)).filter(
    (r) =>
      r.classifier === "electricity.consumption" &&
      r.baseUnit.toLowerCase() === "kwh",
  );
  const resource = options.resourceId
    ? resources.find((r) => r.resourceId === options.resourceId)
    : resources.length === 1
      ? resources[0]
      : undefined;
  if (!resource)
    throw new Error(
      resources.length
        ? "Multiple meters are available. Use list_meters and supply the resourceId for the home you want."
        : "No verified electricity meter is available yet. Complete Set up Smart Meter in Bright/Glow and allow time for readings to arrive.",
    );
  const stream: Stream = {
    id: `glow:${resource.resourceId}`,
    name: resource.entityName,
    source: "glow",
    resourceId: resource.resourceId,
  };
  store.putStream(stream);
  const now = options.now ?? Date.now();
  const total = Math.ceil((range.end - range.start) / (10 * DAY));
  let downloaded = 0,
    cached = 0,
    checked = 0;
  for (let start = range.start; start < range.end; start += 10 * DAY) {
    options.signal?.throwIfAborted();
    const end = Math.min(range.end, start + 10 * DAY),
      previous = store.checkedChunk(stream.id, start, end);
    const count = store.readings(stream.id, start, end).length;
    const fresh = previous && Date.parse(String(previous.checked)) > now - DAY;
    const complete = count === (end - start) / HALF_HOUR;
    // Incomplete old chunks are retried too: newly verified accounts can receive backfill later.
    if (!options.refresh && fresh && complete && end < now - 2 * DAY) cached++;
    else {
      const records = await client.readings(
        resource,
        start,
        end,
        options.signal,
      );
      store.save(stream.id, records, true);
      store.markChunk(stream.id, start, end, records.length, now);
      downloaded += records.length;
      if (options.delayMs !== 0 && end < range.end)
        await sleep(options.delayMs ?? 300, undefined, {
          signal: options.signal,
        });
    }
    options.progress?.(++checked, total);
  }
  return {
    stream: stream.id,
    range: { from: range.from, toExclusive: range.to },
    downloadedIntervals: downloaded,
    cachedChunks: cached,
    checkedChunks: checked,
    availableIntervals: store.readings(stream.id, range.start, range.end)
      .length,
    expectedIntervals: range.expected,
    note: "Only readings available from Glow are downloaded. Empty intervals remain missing; this does not prove the meter has no older history.",
  };
}

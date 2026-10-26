import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import type { Store } from "./store.js";

export function livePower(
  store: Store,
  streamId = "mqtt:home",
  now = Date.now(),
  staleAfterSeconds = 60,
) {
  const reading = store.latestLive(streamId);
  const elapsed = reading ? (now - reading.time) / 1000 : null;
  const status =
    elapsed === null
      ? "unavailable"
      : elapsed < -5
        ? "clock_skew"
        : elapsed > staleAfterSeconds
          ? "stale"
          : "live";
  return {
    streamId,
    status,
    observedAt: reading ? new Date(reading.time).toISOString() : null,
    ageSeconds: elapsed === null ? null : Math.round(elapsed),
    powerWatts: status === "live" ? reading!.powerKw * 1000 : null,
    lastObservedPowerWatts: reading ? reading.powerKw * 1000 : null,
    cumulativeImportKwh: reading?.cumulativeKwh ?? null,
  };
}

export interface PowerApiOptions {
  host?: string;
  port?: number;
  stream?: string;
  token?: string;
  staleAfterSeconds?: number;
}

/** Read-only access to one local stream. No Glow calls or household identifiers. */
export async function startPowerApi(
  store: Store,
  options: PowerApiOptions = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18767;
  const stream = options.stream ?? "mqtt:home";
  const staleAfterSeconds = options.staleAfterSeconds ?? 60;
  const token = options.token;
  if (!isIP(host)) throw new Error("--host must be an IPv4 or IPv6 address.");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port must be an integer between 0 and 65535.");
  if (!stream || stream.length > 200 || /[\u0000-\u001f]/.test(stream))
    throw new Error("Provide a stream ID of 1–200 characters.");
  if (
    !Number.isFinite(staleAfterSeconds) ||
    staleAfterSeconds < 1 ||
    staleAfterSeconds > 3600
  )
    throw new Error("--stale-after must be between 1 and 3600 seconds.");
  if (
    token !== undefined &&
    (token.length < 32 || token.length > 512 || /\s/.test(token))
  )
    throw new Error(
      "ENERGY_LENS_API_TOKEN must contain 32–512 characters without whitespace.",
    );
  const loopback = host === "127.0.0.1" || host === "::1";
  if (!loopback && !token)
    throw new Error(
      "Set ENERGY_LENS_API_TOKEN before listening beyond the loopback interface.",
    );
  const tokenDigest = token
    ? createHash("sha256").update(`Bearer ${token}`).digest()
    : undefined;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    // Reject browser-origin requests and DNS rebinding against an unauthenticated
    // local endpoint. The public dashboard does not contact this private API.
    if (
      request.headers.origin ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, { error: "Browser-origin requests are not supported." });
      return;
    }
    if (tokenDigest) {
      const supplied = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(supplied, tokenDigest)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        send(401, { error: "A valid bearer token is required." });
        return;
      }
    } else {
      const address = server.address();
      const actualPort =
        typeof address === "object" ? address?.port : undefined;
      const hosts = ["127.0.0.1", "localhost", "[::1]"].map(
        (name) => `${name}:${actualPort}`,
      );
      if (!hosts.includes(request.headers.host ?? "")) {
        send(403, { error: "Use a loopback host address." });
        return;
      }
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      send(405, { error: "This API is read-only. Use GET." });
      return;
    }
    if (request.url !== "/v1/power") {
      send(404, {
        error: "Use /v1/power; this API serves one configured stream.",
      });
      return;
    }
    try {
      send(200, livePower(store, stream, Date.now(), staleAfterSeconds));
    } catch {
      send(503, { error: "The local reading store is unavailable." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

import { classifyState, getSessionWindow, settledAt } from "./session-state";

const OPENF1 = "https://api.openf1.org/v1";
const CURRENT_YEAR = new Date().getFullYear();
const TTL_FOREVER = Infinity;
const TTL_1H = 3_600_000;
const TTL_15M = 900_000;
const TTL_5M = 300_000;
const TTL_1M = 60_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const INFLIGHT_WAIT_MS = 20_000;
const MIN_UPSTREAM_INTERVAL_MS = 350;
const MAX_MEMORY_ENTRIES = 64;
const MAX_MEMORY_CHARS = 8_000_000;
const MAX_MEMORY_ENTRY_CHARS = 1_000_000;
const TELEMETRY_ENDPOINTS = ["car_data", "location"];

export interface CacheEnv {
  ANALYTICS?: { writeDataPoint: (event: AnalyticsEngineDataPoint) => void };
}

interface AnalyticsEngineDataPoint {
  blobs?: (string | null)[];
  doubles?: number[];
  indexes?: string[];
}

export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface EdgeCacheStorage extends CacheStorage {
  default: Cache;
}

export const ENDPOINT_ALLOWLIST = new Set([
  "meetings", "sessions", "drivers", "laps", "stints", "pit", "position", "weather",
  "race_control", "session_result", "intervals", "car_data", "location",
  "overtakes", "starting_grid", "team_radio", "championship_drivers", "championship_teams",
]);

export interface KeyPolicy {
  ttl: number;
  edgeMaxAge: number;
  state: "upcoming" | "live" | "recent" | "settled" | "unknown" | "static";
  settledAt: number | null;
  sk: number | null;
}

export interface Resolved {
  status: number;
  body: string;
  xcache: "HIT" | "MISS" | "STALE" | "ERROR";
  policy: KeyPolicy;
  fetchedAt: number | null;
  upstreamCalls: number;
}

interface MemoryEntry { body: string; fetchedAt: number }
const memoryCache = new Map<string, MemoryEntry>();
const inflight = new Map<string, Promise<{ ok: boolean; status: number; body: string }>>();
let memoryChars = 0;
let nextUpstreamAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeKey(path: string): string {
  const [base, qs] = path.split("?");
  const clean = base.replace(/^\//, "");
  if (!qs) return clean;
  const params = [...new URLSearchParams(qs).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return clean + "?" + params.map(([k, v]) => `${k}=${v}`).join("&");
}

async function waitForUpstreamSlot(): Promise<void> {
  let release!: () => void;
  const previous = rateLimitQueue;
  rateLimitQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const delay = Math.max(0, nextUpstreamAt - Date.now());
    if (delay > 0) await sleep(delay);
    nextUpstreamAt = Date.now() + MIN_UPSTREAM_INTERVAL_MS;
  } finally {
    release();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + " timed out")), ms);
    p.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function fetchUpstreamOnce(fetchPath: string): Promise<{ ok: boolean; status: number; body: string }> {
  const existing = inflight.get(fetchPath);
  if (existing) return withTimeout(existing, INFLIGHT_WAIT_MS, "shared upstream call");

  const request = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await waitForUpstreamSlot();
        const response = await fetch(OPENF1 + fetchPath, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        return { ok: response.ok, status: response.status, body: await response.text() };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(400);
      }
    }
    throw lastError ?? new Error("OpenF1 request failed");
  })();
  inflight.set(fetchPath, request);
  try {
    return await request;
  } finally {
    inflight.delete(fetchPath);
  }
}

export async function policyFor(key: string): Promise<KeyPolicy> {
  const yearMatch = key.match(/year=(\d+)/);
  if (yearMatch && Number(yearMatch[1]) < CURRENT_YEAR) {
    return { ttl: TTL_FOREVER, edgeMaxAge: 604_800, state: "static", settledAt: null, sk: null };
  }
  if (key.startsWith("meetings") || key.startsWith("sessions")) {
    return { ttl: TTL_1H, edgeMaxAge: 300, state: "static", settledAt: null, sk: null };
  }
  const sessionMatch = key.match(/session_key=(\d+)/);
  if (sessionMatch) {
    const sk = Number(sessionMatch[1]);
    const window = await getSessionWindow(sk, fetchUpstreamOnce);
    const state = classifyState(window);
    switch (state) {
      case "upcoming": return { ttl: TTL_5M, edgeMaxAge: 60, state, settledAt: null, sk };
      case "live": return { ttl: TTL_1M, edgeMaxAge: 30, state, settledAt: null, sk };
      case "recent": return { ttl: TTL_15M, edgeMaxAge: 300, state, settledAt: null, sk };
      case "settled": return { ttl: TTL_FOREVER, edgeMaxAge: 604_800, state, settledAt: window ? settledAt(window) : null, sk };
      default: return { ttl: TTL_15M, edgeMaxAge: 300, state: "unknown", settledAt: null, sk };
    }
  }
  return { ttl: TTL_15M, edgeMaxAge: 300, state: "unknown", settledAt: null, sk: null };
}

function getMemoryEntry(key: string): MemoryEntry | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > 7 * 24 * 60 * 60_000) {
    memoryCache.delete(key);
    memoryChars -= entry.body.length;
    return undefined;
  }
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry;
}

function setMemoryEntry(key: string, entry: MemoryEntry): void {
  if (entry.body.length > MAX_MEMORY_ENTRY_CHARS) return;
  const previous = memoryCache.get(key);
  if (previous) {
    memoryChars -= previous.body.length;
    memoryCache.delete(key);
  }
  while (memoryCache.size >= MAX_MEMORY_ENTRIES || memoryChars + entry.body.length > MAX_MEMORY_CHARS) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) return;
    const oldest = memoryCache.get(oldestKey);
    if (oldest) memoryChars -= oldest.body.length;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, entry);
  memoryChars += entry.body.length;
}

export async function resolveResource(
  apiPath: string,
  _env: CacheEnv,
  ctx: WorkerContext | null,
  origin?: string,
): Promise<Resolved> {
  const key = normalizeKey(apiPath);
  const policy = await policyFor(key);
  const edgeKey = origin ? edgeCacheKey(origin, apiPath) : null;
  if (edgeKey) {
    const response = await (caches as EdgeCacheStorage).default.match(edgeKey);
    if (response) {
      return {
        status: 200,
        body: await response.text(),
        xcache: "HIT",
        policy,
        fetchedAt: null,
        upstreamCalls: 0,
      };
    }
  }
  const cached = getMemoryEntry(key);
  if (cached && Date.now() - cached.fetchedAt < policy.ttl) {
    return { status: 200, body: cached.body, xcache: "HIT", policy, fetchedAt: cached.fetchedAt, upstreamCalls: 0 };
  }

  let upstream: { ok: boolean; status: number; body: string } | null = null;
  try { upstream = await fetchUpstreamOnce(apiPath); } catch { upstream = null; }
  if (upstream?.ok) {
    let body = upstream.body;
    if (origin && TELEMETRY_ENDPOINTS.includes(key.split("?")[0])) {
      const filters = getDateFilters(new URL(OPENF1 + apiPath));
      if (filters) {
        try { body = JSON.stringify(sliceByDate(JSON.parse(body) as unknown[], filters)); } catch { /* retain source response */ }
      }
    }
    const fetchedAt = Date.now();
    setMemoryEntry(key, { body, fetchedAt });
    if (edgeKey && body.length <= MAX_MEMORY_ENTRY_CHARS) {
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=60, s-maxage=${policy.edgeMaxAge}`,
          "X-Session-State": policy.state,
          "X-Cache": "MISS",
          "X-Upstream-Calls": "1",
        },
      });
      const write = (caches as EdgeCacheStorage).default.put(edgeKey, response);
      if (ctx) ctx.waitUntil(write);
      else await write;
    }
    return { status: 200, body, xcache: "MISS", policy, fetchedAt, upstreamCalls: 1 };
  }
  if (upstream?.status === 404 && policy.state === "settled") {
    const fetchedAt = Date.now();
    setMemoryEntry(key, { body: "[]", fetchedAt });
    return { status: 200, body: "[]", xcache: "MISS", policy, fetchedAt, upstreamCalls: 1 };
  }
  if (cached) {
    return { status: 200, body: cached.body, xcache: "STALE", policy, fetchedAt: cached.fetchedAt, upstreamCalls: 1 };
  }
  const status = upstream?.status ?? 502;
  const body = upstream?.body && (status === 401 || status === 429)
    ? upstream.body
    : JSON.stringify({ error: "OpenF1 API unavailable" });
  return { status, body, xcache: "ERROR", policy, fetchedAt: null, upstreamCalls: 1 };
}

function edgeCacheKey(origin: string, apiPath: string): Request {
  return new Request(`${origin}/api/f1/${normalizeKey(apiPath)}`);
}

function getDateFilters(url: URL): { gte?: string; lte?: string } | null {
  const gte = url.searchParams.get("date>=") || url.searchParams.get("date>") || undefined;
  const lte = url.searchParams.get("date<=") || url.searchParams.get("date<") || undefined;
  return gte || lte ? { gte, lte } : null;
}

function sliceByDate(rows: unknown[], filters: { gte?: string; lte?: string }): unknown[] {
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .filter(row => typeof row.date !== "string"
      || ((!filters.gte || row.date >= filters.gte) && (!filters.lte || row.date <= filters.lte)));
}

export async function handleF1Request(request: Request, env: CacheEnv, ctx: WorkerContext): Promise<Response> {
  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api\/f1/, "") + url.search;
  const endpoint = url.pathname.replace(/^\/api\/f1\//, "").split("/")[0];
  const record = (status: string, state: string, upstreamCalls = 0) => {
    try {
      env.ANALYTICS?.writeDataPoint?.({
        blobs: [endpoint, status, state],
        doubles: [1, upstreamCalls],
        indexes: [endpoint],
      });
    } catch (error) {
      console.warn("Analytics Engine write failed; continuing without analytics.", error);
    }
  };

  if (!ENDPOINT_ALLOWLIST.has(endpoint)) {
    record("blocked", "static");
    return Response.json({ error: "Unknown endpoint" }, { status: 404 });
  }

  const cache = (caches as EdgeCacheStorage).default;
  const cacheKey = edgeCacheKey(url.origin, apiPath);
  const cached = await cache.match(cacheKey);
  if (cached) {
    record("edge", cached.headers.get("X-Session-State") ?? "");
    return cached;
  }

  const result = await resolveResource(apiPath, env, ctx);
  let body = result.body;
  if (result.status === 200 && ["car_data", "location"].includes(endpoint)) {
    const filters = getDateFilters(url);
    if (filters) {
      try { body = JSON.stringify(sliceByDate(JSON.parse(body) as unknown[], filters)); } catch { /* keep upstream body */ }
    }
  }
  record(result.xcache.toLowerCase(), result.policy.state, result.upstreamCalls);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Cache": result.xcache,
    "X-Session-State": result.policy.state,
    "X-Upstream-Calls": String(result.upstreamCalls),
  });
  if (result.xcache === "ERROR") return new Response(body, { status: result.status, headers });
  headers.set("Cache-Control", result.xcache === "STALE"
    ? "public, max-age=60, s-maxage=30"
    : `public, max-age=60, s-maxage=${result.policy.edgeMaxAge}`);
  const response = new Response(body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export function resetResourceCacheForTests(): void {
  memoryCache.clear();
  memoryChars = 0;
  inflight.clear();
  nextUpstreamAt = 0;
  rateLimitQueue = Promise.resolve();
}

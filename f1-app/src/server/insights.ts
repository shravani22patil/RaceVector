// GET /api/session/:sk/insights — the engine run server-side on the same
// bundle the client uses: verdicts plus compact facts. Results are cached at
// the edge and in a bounded isolate cache; there is no persistent artifact store.

import type { CacheEnv } from "./openf1-cache";
import { assembleBundle, edgeForState } from "./bundle";
import type { SessionState } from "./session-state";
import { inputsFromBundle } from "../engine/bundle.ts";
import { buildSessionModel } from "../engine/session/build.ts";
import { buildFacts, type AnalysisFacts } from "../engine/summary/facts.ts";

const VERSION = 1;
const INSIGHTS_CACHE_TTL = 5 * 60_000;
const MAX_INSIGHTS_CACHE = 32;
const insightsCache = new Map<number, { body: string; state: SessionState; at: number }>();

export interface InsightsPayload extends AnalysisFacts {
  meta: { sessionKey: number; state: string; generatedAt: string; version: number; missing: string[] };
}

export async function computeInsights(sk: number, env: CacheEnv, ctx: ExecutionContext, opts: { force?: boolean; origin?: string } = {}): Promise<{ status: number; body: string; state: SessionState; cached: boolean }> {
  if (!opts.force) {
    const cached = insightsCache.get(sk);
    if (cached && Date.now() - cached.at < INSIGHTS_CACHE_TTL) {
      insightsCache.delete(sk);
      insightsCache.set(sk, cached);
      return { status: 200, body: cached.body, state: cached.state, cached: true };
    }
    if (cached) insightsCache.delete(sk);
  }

  const a = await assembleBundle(sk, env, ctx, opts.origin);
  if (!a.ok) return { status: a.status, body: a.body, state: "unknown", cached: false };
  // One parse of the spliced bundle; the engine runs on it here, server-side.
  const model = buildSessionModel(inputsFromBundle(JSON.parse(a.body)));
  const facts = buildFacts(model);
  const payload: InsightsPayload = {
    ...facts,
    meta: { sessionKey: sk, state: a.state, generatedAt: new Date().toISOString(), version: VERSION, missing: a.meta.missing },
  };
  const body = JSON.stringify(payload);
  if (body.length < 1_000_000) {
    if (insightsCache.size >= MAX_INSIGHTS_CACHE) {
      const oldest = insightsCache.keys().next().value;
      if (oldest !== undefined) insightsCache.delete(oldest);
    }
    insightsCache.set(sk, { body, state: a.state, at: Date.now() });
  }
  return { status: 200, body, state: a.state, cached: false };
}

export async function handleSessionInsightsRequest(request: Request, env: CacheEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/session\/(\d+)\/insights\/?$/);
  if (!m) return null;
  const cache = caches.default;
  const cacheKey = new Request(url.origin + url.pathname);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const sk = Number(m[1]);
  const r = await computeInsights(sk, env, ctx, { origin: url.origin });
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Cache": r.cached ? "HIT" : "MISS", "X-Session-State": r.state };
  if (r.status !== 200) {
    if (r.status === 429) headers["Retry-After"] = "12";
    return new Response(r.body, { status: r.status, headers });
  }
  headers["Cache-Control"] = `public, max-age=60, s-maxage=${Math.min(edgeForState(r.state, false), 300)}`;
  const response = new Response(r.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export function resetInsightsCacheForTests(): void {
  insightsCache.clear();
}

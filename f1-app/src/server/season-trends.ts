// Precomputed season trends need persistent artifact storage. Do not synthesize
// an empty or incomplete trends payload when that storage is unavailable.

export async function handleSeasonTrendsRequest(opts: {
  url: URL;
}): Promise<Response | null> {
  const m = opts.url.pathname.match(/^\/api\/season-trends\/(\d{4})\/?$/);
  if (!m) return null;
  const year = m[1];
  return Response.json(
    { error: "Precomputed season trends require persistent storage and are unavailable.", year },
    { status: 503 },
  );
}

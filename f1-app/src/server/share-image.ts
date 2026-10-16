// User-uploaded chart images need persistent object storage, unavailable on
// the no-R2 deployment. Keep the routes explicit rather than claiming uploads
// succeeded or serving placeholder content.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function handleShareImageUpload(opts: {
  request: Request;
}): Promise<Response> {
  const { request } = opts;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  return Response.json({ error: "Chart image sharing requires persistent storage and is unavailable." }, {
    status: 503,
    headers: CORS_HEADERS,
  });
}

export async function handleShareImageRead(opts: {
  url: URL;
}): Promise<Response | null> {
  if (!/^\/share\/img\/[a-f0-9]+\.png$/.test(opts.url.pathname)) return null;
  return new Response("Chart image sharing requires persistent storage and is unavailable.", { status: 503 });
}

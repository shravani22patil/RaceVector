// Operator routes remain authenticated but are unavailable without persistent
// storage; returning success would falsely imply that cache state was changed.

export interface AdminEnv {
  ADMIN_TOKEN?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request, env: AdminEnv): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return token.length > 0 && timingSafeEqual(token, env.ADMIN_TOKEN);
}

export async function handleAdminRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;
  if (!authorised(request, env)) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const action = url.pathname.replace("/api/admin/", "");
  if (!["cron", "insights", "purge", "refresh"].includes(action)) return json({ error: "unknown action" }, 404);
  return json({ error: "Operator actions require persistent storage, which is not configured." }, 503);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

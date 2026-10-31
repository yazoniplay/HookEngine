// The Chrome extension has no stable web origin that can be safely allowlisted here.
// Authentication is enforced separately with the caller's Supabase access token.
// Keep wildcard CORS only for this public browser-invoked endpoint; do not enable credentials.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export function jsonReply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export function corsPreflight(): Response {
  return new Response("ok", { headers: CORS_HEADERS });
}

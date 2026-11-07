// CORS is an allowlist, never a wildcard. A request whose Origin is not listed gets no
// Access-Control-Allow-Origin header, so browsers refuse to expose the response to that page.
// The Chrome extension itself is unaffected: its host_permissions let the service worker and
// popup call this endpoint without a CORS check. Authentication is still enforced separately
// with the caller's Supabase access token. Do not enable credentials.

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["https://yazoniplay.github.io"];

const BASE_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};

/** Parse a comma-separated origin list; fall back to the defaults when it is empty. */
export function parseAllowedOrigins(
  raw: string | null | undefined,
  fallback: readonly string[] = DEFAULT_ALLOWED_ORIGINS,
): string[] {
  const parsed = (raw || "").split(",").map((value) => value.trim()).filter(Boolean);
  return parsed.length ? parsed : [...fallback];
}

export function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[] = DEFAULT_ALLOWED_ORIGINS,
): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (origin && allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function jsonReply(data: unknown, status = 200, cors: Record<string, string> = buildCorsHeaders(null)): Response {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

export function corsPreflight(cors: Record<string, string> = buildCorsHeaders(null)): Response {
  return new Response("ok", { headers: cors });
}

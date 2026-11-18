import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  buildCorsHeaders,
  corsPreflight,
  DEFAULT_ALLOWED_ORIGINS,
  jsonReply,
  parseAllowedOrigins,
} from "../supabase/functions/hookengine-generate/http-response.ts";

const PORTAL = "https://yazoniplay.github.io";
const ALLOWED = [PORTAL, "chrome-extension://abcdefghijklmnopabcdefghijklmnop"];

Deno.test("JSON error responses echo an allowed origin and keep no-store headers", async () => {
  const response = jsonReply({ error: "Reservation unavailable." }, 503, buildCorsHeaders(PORTAL, ALLOWED));
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), PORTAL);
  assertEquals(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(response.headers.get("Vary"), "Origin");
  assertEquals(await response.json(), { error: "Reservation unavailable." });
});

Deno.test("an origin that is not allowlisted gets no Access-Control-Allow-Origin header", () => {
  for (const origin of ["https://evil.example", "null", "https://yazoniplay.github.io.evil.example", null]) {
    const response = jsonReply({ error: "x" }, 401, buildCorsHeaders(origin, ALLOWED));
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
    assertEquals(response.headers.get("Vary"), "Origin");
  }
});

Deno.test("the wildcard origin is never emitted", () => {
  assertNotEquals(buildCorsHeaders("*", ALLOWED)["Access-Control-Allow-Origin"], "*");
  assertNotEquals(buildCorsHeaders(PORTAL)["Access-Control-Allow-Origin"], "*");
});

Deno.test("CORS preflight supports browser POST requests from an allowed origin", () => {
  const response = corsPreflight(buildCorsHeaders(PORTAL, ALLOWED));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), PORTAL);
  assertEquals(response.headers.get("Access-Control-Allow-Headers"), "authorization, x-client-info, apikey, content-type");
});

Deno.test("allowed origins parse from a comma-separated list and fall back to the portal", () => {
  assertEquals(parseAllowedOrigins(" https://a.example , ,chrome-extension://abc "), [
    "https://a.example",
    "chrome-extension://abc",
  ]);
  assertEquals(parseAllowedOrigins(""), [...DEFAULT_ALLOWED_ORIGINS]);
  assertEquals(parseAllowedOrigins(undefined), [...DEFAULT_ALLOWED_ORIGINS]);
});

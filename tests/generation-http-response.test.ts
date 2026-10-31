import { assertEquals } from "jsr:@std/assert@1";
import { corsPreflight, jsonReply } from "../supabase/functions/hookengine-generate/http-response.ts";

Deno.test("JSON error responses retain CORS and no-store headers", async () => {
  const response = jsonReply({ error: "Reservation unavailable." }, 503);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals(await response.json(), { error: "Reservation unavailable." });
});

Deno.test("CORS preflight supports browser POST requests", () => {
  const response = corsPreflight();
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(response.headers.get("Access-Control-Allow-Headers"), "authorization, x-client-info, apikey, content-type");
});

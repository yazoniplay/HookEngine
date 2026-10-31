import { assertEquals } from "jsr:@std/assert@1";
import {
  GENERATION_SYSTEM_INSTRUCTION,
  parseOutputs,
  runWithProviderFallback,
  schemaFor,
  serializeOutput,
  shouldFallback,
  validateGenerationPayload,
  validYouTube,
  VARIATION_SEPARATOR,
} from "../supabase/functions/hookengine-generate/generation-contract.ts";

const source = "A sufficiently long source article for HookEngine validation tests. ".repeat(2);

Deno.test("accepts valid Free request and supplies safe preference defaults", () => {
  const result = validateGenerationPayload({ text: source });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.platforms, ["x_thread", "linkedin_post", "tiktok_hooks"]);
    assertEquals(result.value.preferences, {
      tone: "balanced", style: "platform_native", length: "platform_default", audience: "",
    });
    assertEquals(result.value.actionType, "generation");
  }
});

Deno.test("rejects malformed platform arrays, duplicates and unsupported plan keys", () => {
  assertEquals(validateGenerationPayload({ text: source, platforms: "x_thread" }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, platforms: ["x_thread", "x_thread"] }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, platforms: ["x_thread", "admin"] }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, platforms: [] }).ok, false);
});

Deno.test("rejects invalid source URL, oversized title and invalid preferences", () => {
  assertEquals(validateGenerationPayload({ text: source, sourceUrl: "javascript:alert(1)" }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, title: "x".repeat(301) }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, preferences: { tone: "unrestricted" } }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, preferences: { extra: "field" } }).ok, false);
  assertEquals(validateGenerationPayload({ text: source, preferences: { audience: "x".repeat(161) } }).ok, false);
});

Deno.test("validates YouTube host, protocol and video ID", () => {
  assertEquals(validYouTube("https://www.youtube.com/watch?v=abcdefghijk"), true);
  assertEquals(validYouTube("https://youtu.be/abcdefghijk"), true);
  assertEquals(validYouTube("http://youtube.com/watch?v=abcdefghijk"), false);
  assertEquals(validYouTube("https://youtube.com.evil.test/watch?v=abcdefghijk"), false);
  assertEquals(validYouTube("https://youtube.com/watch?v=short"), false);
});

Deno.test("regeneration requires a UUID parent and generation rejects stray parent IDs", () => {
  assertEquals(validateGenerationPayload({
    text: source, actionType: "regeneration", parentGenerationId: "not-a-uuid",
  }).ok, false);
  assertEquals(validateGenerationPayload({
    text: source, parentGenerationId: "10000000-0000-4000-8000-000000000001",
  }).ok, false);
  const valid = validateGenerationPayload({
    text: source, actionType: "regeneration", parentGenerationId: "10000000-0000-4000-8000-000000000001",
  });
  assertEquals(valid.ok, true);
});

Deno.test("accepts array outputs and legacy separator strings but enforces variation count", () => {
  const arrayResult = parseOutputs(JSON.stringify({ x_thread: ["Draft one", "Draft two", "Draft three"] }), ["x_thread"], 3);
  assertEquals(arrayResult, { x_thread: ["Draft one", "Draft two", "Draft three"] });

  const legacy = parseOutputs(JSON.stringify({
    x_thread: ["Draft one", "Draft two", "Draft three"].join(VARIATION_SEPARATOR),
  }), ["x_thread"], 3);
  assertEquals(legacy, { x_thread: ["Draft one", "Draft two", "Draft three"] });

  assertEquals(parseOutputs(JSON.stringify({ x_thread: ["Only one"] }), ["x_thread"], 3), null);
  assertEquals(parseOutputs(JSON.stringify({ x_thread: ["A", "B"], extra: "no" }), ["x_thread"], 2), null);
  assertEquals(parseOutputs(JSON.stringify({ x_thread: ["", "B", "C"] }), ["x_thread"], 3), null);
});

Deno.test("single-output schema stays string; multi-output schema requests arrays", () => {
  assertEquals((schemaFor(["x_thread"], 1).properties as Record<string, {type:string}>).x_thread.type, "STRING");
  const multi = (schemaFor(["x_thread"], 3).properties as Record<string, {type:string;items:{type:string}}>).x_thread;
  assertEquals(multi.type, "ARRAY");
  assertEquals(multi.items.type, "STRING");
});

Deno.test("serialized legacy columns preserve all variations", () => {
  assertEquals(serializeOutput(["one", "two"]), "one" + VARIATION_SEPARATOR + "two");
  assertEquals(serializeOutput(undefined), null);
});

Deno.test("provider failures can fall back, malformed request errors cannot", () => {
  const badRequest = Object.assign(new Error("invalid request"), { status: 400 });
  const unauthorized = Object.assign(new Error("invalid key"), { status: 401 });
  assertEquals(shouldFallback(badRequest), false);
  assertEquals(shouldFallback(unauthorized), true);
  assertEquals(shouldFallback(new TypeError("network")), true);
});

Deno.test("system instruction explicitly treats source content as untrusted", () => {
  assertEquals(GENERATION_SYSTEM_INSTRUCTION.includes("untrusted data"), true);
});


Deno.test("provider fallback runs Groq after Gemini failure and records the actual provider", async () => {
  const result = await runWithProviderFallback(
    async () => { throw new TypeError("Gemini network timeout"); },
    [{ name: "Groq", run: async () => "fallback draft" }],
  );
  assertEquals(result, { value: "fallback draft", provider: "Groq", fallbackUsed: true });
});

Deno.test("provider fallback does not mask a non-retryable Gemini request error", async () => {
  let fallbackCalled = false;
  const error = Object.assign(new Error("invalid prompt"), { status: 400 });
  try {
    await runWithProviderFallback(
      async () => { throw error; },
      [{ name: "Groq", run: async () => { fallbackCalled = true; return "draft"; } }],
    );
  } catch (caught) {
    assertEquals(caught, error);
  }
  assertEquals(fallbackCalled, false);
});

Deno.test("provider fallback reports unavailable when every provider fails", async () => {
  let message = "";
  try {
    await runWithProviderFallback(
      async () => { throw new TypeError("network"); },
      [{ name: "Groq", run: async () => { throw new Error("down"); } }],
    );
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(message, "AI providers are temporarily unavailable. Please try again shortly.");
});

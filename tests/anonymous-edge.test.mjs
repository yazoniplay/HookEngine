import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const FUNCTION_PATH = "supabase/functions/hookengine-generate/index.ts";

function assertAnonymousEdge(src) {
  const handler = src.slice(src.indexOf("async function handleAnonymousGeneration"), src.indexOf("async function handleRequest"));
  assert.ok(handler.length > 500, "anonymous handler must exist");
  assert.match(src, /const hasBearer = \/\^Bearer\\s\+\\S\+\/i\.test/, "requests with a token must be detected");
  assert.match(src, /if \(!userId && hasBearer\) return reply\(\{ error: "Sign in to HookEngine/,
    "an invalid token must still be rejected with 401");
  assert.match(src, /if \(!userId\) return await handleAnonymousGeneration\(req\);/, "tokenless requests must go anonymous");
  assert.match(handler, /: await generateText\(/, "anonymous text path must reuse generateText (Gemini -> Groq -> Ollama)");
  assert.match(handler, /generateYouTube\(payload\.sourceUrl/, "anonymous video path must reuse the account video path");
  assert.match(handler, /const cost = isVideo \? 5 : 1;/, "videos must cost 5 credits and text 1 credit anonymously");
  assert.match(handler, /p_ip_limit: ANONYMOUS_IP_DAILY_CREDITS,\s*p_global_limit: GLOBAL_DAILY_CREDIT_CAP,\s*p_cost: cost/,
    "anonymous path must pass the per-IP credit limit, the global credit cap and the cost to the database");
  assert.match(src, /const ANONYMOUS_IP_DAILY_CREDITS = 10;/, "per-IP daily credit limit must be 10");
  assert.match(src, /: 100;\s*\}\)\(\);/, "global daily credit cap must default to 100");
  assert.match(handler, /"Global daily limit reached\. Try again tomorrow\."/, "global cap message must match the spec exactly");
  assert.match(handler, /\}, 429\);/, "limit responses must use HTTP 429");
  assert.match(handler, /rpc\("hookengine_refund_anonymous", \{ p_ip_hash: bucket, p_cost: cost \}\)/,
    "failed generations must give the credits back");
  assert.match(src, /const parts = \(req\.headers\.get\("x-forwarded-for"\) \|\| ""\)[\s\S]*?const last = parts\.at\(-1\);/,
    "client IP must come from the rightmost forwarded entry");
  assert.doesNotMatch(handler, /YouTube video analysis is not available without an account/,
    "video analysis must no longer be refused anonymously");
  assert.doesNotMatch(handler, /console\.(log|error)\([^)]*ip\b/, "raw IP must never be logged");
}

test("anonymous generation path is wired to the credit caps, the shared provider chain and the video path", async () => {
  assertAnonymousEdge(await readFile(FUNCTION_PATH, "utf8"));
});

test("mutation: anonymous text path bypasses the shared provider chain", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace(": await generateText(", ": await fakeProvider(");
  assert.notEqual(mutated, src, "mutation must change the text path");
  assert.throws(() => assertAnonymousEdge(mutated), /reuse generateText/);
});

test("mutation: videos charged the text price anonymously", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace("const cost = isVideo ? 5 : 1;", "const cost = 1;");
  assert.notEqual(mutated, src, "mutation must change the cost");
  assert.throws(() => assertAnonymousEdge(mutated), /5 credits and text 1 credit/);
});

test("mutation: video refused again anonymously", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace(
    "const isVideo = payload.sourceMode === \"youtube_video\";",
    "const isVideo = payload.sourceMode === \"youtube_video\";\n  if (isVideo) return reply({ error: \"YouTube video analysis is not available without an account. Paste the article or text instead.\" }, 403);",
  );
  assert.notEqual(mutated, src, "mutation must add the refusal");
  assert.throws(() => assertAnonymousEdge(mutated), /no longer be refused anonymously/);
});

test("mutation: invalid tokens fall through to anonymous use", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace("if (!userId && hasBearer) return", "if (false) return");
  assert.throws(() => assertAnonymousEdge(mutated), /invalid token must still be rejected/);
});

test("mutation: global cap message changed", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace("Global daily limit reached. Try again tomorrow.", "Limit reached.");
  assert.throws(() => assertAnonymousEdge(mutated), /global cap message/);
});

test("mutation: client IP taken from the leftmost (client-supplied) entry", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace("const last = parts.at(-1);", "const last = parts[0];");
  assert.throws(() => assertAnonymousEdge(mutated), /rightmost forwarded entry/);
});

test("mutation: refund on failure removed", async () => {
  const src = await readFile(FUNCTION_PATH, "utf8");
  const mutated = src.replace('await rpc("hookengine_refund_anonymous", { p_ip_hash: bucket, p_cost: cost });', "");
  assert.notEqual(mutated, src, "mutation must remove the refund");
  assert.throws(() => assertAnonymousEdge(mutated), /give the credits back/);
});

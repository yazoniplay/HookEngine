import test from "node:test";
import assert from "node:assert/strict";
import { ALL_PLATFORMS, FREE_PLATFORMS, VARIATION_SEPARATOR, PLATFORM_LABELS } from "../extension/config.js";
import { PLAN_CATALOG } from "../extension/plans.js";
import { readFile } from "node:fs/promises";

test("extension runtime has one authoritative platform and variation contract", async () => {
  assert.equal(typeof VARIATION_SEPARATOR, "string");
  assert.ok(VARIATION_SEPARATOR.length > 0);
  assert.deepEqual(FREE_PLATFORMS, ["x_thread", "linkedin_post", "tiktok_hooks"]);
  assert.deepEqual(ALL_PLATFORMS, [
    "x_thread", "linkedin_post", "tiktok_hooks",
    "instagram_caption", "threads_posts", "facebook_post"
  ]);
  assert.deepEqual(PLAN_CATALOG.free.platforms, FREE_PLATFORMS);
  for (const key of ["trial", "pro", "lifetime"]) {
    assert.deepEqual(PLAN_CATALOG[key].platforms, ALL_PLATFORMS);
  }
  assert.deepEqual(Object.keys(PLATFORM_LABELS), ALL_PLATFORMS);
});

test("background fallback uses the shared platform list", async () => {
  const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(source, /ALL_PLATFORMS/);
  assert.doesNotMatch(source, /\["x_thread",\s*"linkedin_post",\s*"tiktok_hooks",\s*"instagram_caption"/);
});

test("account history uses shared platform labels", async () => {
  const source = await readFile(new URL("../account/account.js", import.meta.url), "utf8");
  assert.match(source, /PLATFORM_LABELS/);
  assert.doesNotMatch(source, /const labels\s*=\s*\{\s*x_thread:/);
});

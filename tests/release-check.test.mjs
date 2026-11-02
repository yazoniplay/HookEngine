import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { configuredSupportEmail } from "../scripts/phase-6-release-check.mjs";

test("Phase 6 release check blocks an empty support address", async () => {
  const support = await readFile(new URL("../support.js", import.meta.url), "utf8");
  assert.throws(() => configuredSupportEmail(support), /SUPPORT_EMAIL must be configured/);
  const configured = support.replace('SUPPORT_EMAIL = ""', 'SUPPORT_EMAIL = "support@example.test"');
  assert.equal(configuredSupportEmail(configured), "support@example.test");
});

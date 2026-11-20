import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const NEW_PLATFORMS = ["youtube_shorts_script", "reddit_post", "facebook_post"];
const EDGE = "supabase/functions/hookengine-generate/index.ts";
const CONTRACT = "supabase/functions/hookengine-generate/generation-contract.ts";
const MIGRATION = "supabase/migrations/20261120130000_hookengine_new_platforms.sql";

function assertPlatformWiring({ edge, contract, background, config, popup, migration }) {
  for (const key of NEW_PLATFORMS) {
    assert.match(edge, new RegExp("\\n  " + key + ": \""), key + " must have generation guidance");
    assert.match(contract, new RegExp("\"" + key + "\""), key + " must be an allowed platform");
    assert.match(background, new RegExp("\"" + key + "\""), key + " must be read by the worker");
    assert.match(config, new RegExp(key + ": \""), key + " must have a label");
    assert.match(popup, new RegExp("value=\"" + key + "\""), key + " must have a popup option");
    assert.match(migration, new RegExp("'" + key + "'"), key + " must be granted to every plan");
  }
}

function assertHumanWritingRules(edge) {
  const rules = edge.match(/HUMAN_WRITING_RULES = "([^"]*)"/);
  assert.ok(rules, "shared human writing rules exist");
  for (const phrase of ["emojis", "em dashes", "not X but Y", "Unpopular opinion", "stop scrolling", "let that sink in"]) {
    assert.ok(rules[1].toLowerCase().includes(phrase.toLowerCase()), "rules must forbid " + phrase);
  }
  const lines = edge.split("\n");
  for (const key of NEW_PLATFORMS) {
    const line = lines.find(l => l.trimStart().startsWith(key + ":"));
    assert.ok(line && line.includes("HUMAN_WRITING_RULES"), key + " guidance must use the shared rules");
    assert.doesNotMatch(line, /—/, key + " guidance must not contain em dashes");
  }
}

async function load() {
  const [edge, contract, background, config, popup, migration] = await Promise.all([
    readFile(EDGE, "utf8"),
    readFile(CONTRACT, "utf8"),
    readFile("background.js", "utf8"),
    readFile("extension/config.js", "utf8"),
    readFile("popup.html", "utf8"),
    readFile(MIGRATION, "utf8"),
  ]);
  return { edge, contract, background, config, popup, migration };
}

test("new platforms are wired through worker, labels, popup, contract and plans", async () => {
  assertPlatformWiring(await load());
});

test("shared human-writing rules forbid AI tells and apply to every new platform", async () => {
  assertHumanWritingRules((await load()).edge);
});

test("mutation: dropping a plan grant is rejected", async () => {
  const d = await load();
  const mutated = { ...d, migration: d.migration.replace("'facebook_post'", "'facebook'") };
  assert.throws(() => assertPlatformWiring(mutated), /must be granted/);
});

test("mutation: removing the emoji ban is rejected", async () => {
  const d = await load();
  const mutated = d.edge.replace("No emojis, ", "");
  assert.notEqual(mutated, d.edge);
  assert.throws(() => assertHumanWritingRules(mutated), /forbid emojis/);
});

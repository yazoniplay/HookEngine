import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const MIGRATION = "supabase/migrations/20261118130000_hookengine_anonymous_ip_caps.sql";

function assertAnonymousCapSecurity(sql) {
  assert.match(sql, /enable row level security/, "usage table must enable RLS");
  assert.match(sql, /revoke all on table public\.hookengine_anonymous_usage from public, anon, authenticated;/,
    "usage table must be revoked from anon and authenticated");
  assert.doesNotMatch(sql, /grant [^;]*on table public\.hookengine_anonymous_usage to (anon|authenticated)/,
    "usage table must not be granted to anon or authenticated");
  for (const fn of [
    "hookengine_reserve_anonymous(text, integer, integer)",
    "hookengine_refund_anonymous(text)",
    "hookengine_prune_anonymous_usage()"
  ]) {
    assert.match(sql, new RegExp("grant execute on function public\\." + fn.replace(/[()]/g, "\\$&") + " to service_role;"),
      fn + " must be granted to service_role");
    assert.doesNotMatch(sql, new RegExp("grant execute on function public\\." + fn.replace(/[()]/g, "\\$&") + " to (anon|authenticated|public)"),
      fn + " must not be executable by anon or authenticated");
  }
  assert.match(sql, /char_length\(p_ip_hash\) <> 64/, "IP bucket must be a 64-character hash");
  const globalCheck = sql.indexOf("if v_global >= p_global_limit");
  const ipCheck = sql.indexOf("if v_ip >= p_ip_limit");
  assert.ok(globalCheck > 0 && ipCheck > globalCheck, "global cap must be checked before the per-IP cap");
  assert.doesNotMatch(sql, /ip_address|inet|x-forwarded-for/i, "migration must not store raw IP addresses");
}

test("anonymous cap migration is service-role only and stores hashes only", async () => {
  assertAnonymousCapSecurity(await readFile(MIGRATION, "utf8"));
});

test("mutation: granting the usage table to anon is rejected", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const mutated = sql + "\ngrant select on table public.hookengine_anonymous_usage to anon;\n";
  assert.throws(() => assertAnonymousCapSecurity(mutated), /must not be granted/);
});

test("mutation: exposing the reserve function to anon is rejected", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const mutated = sql + "\ngrant execute on function public.hookengine_reserve_anonymous(text, integer, integer) to anon;\n";
  assert.throws(() => assertAnonymousCapSecurity(mutated), /must not be executable by anon/);
});

test("mutation: checking the IP cap before the global cap is rejected", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const swapped = sql
    .replace("if v_global >= p_global_limit then", "if v_ip >= p_ip_limit then")
    .replace("if v_ip >= p_ip_limit then\n    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'ip_limit'", "if v_global >= p_global_limit then\n    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'ip_limit'");
  assert.notEqual(swapped, sql, "mutation must change the check order");
  assert.throws(() => assertAnonymousCapSecurity(swapped), /global cap must be checked before/);
});

test("mutation: storing raw IP addresses is rejected", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const mutated = sql.replace("bucket text not null,", "bucket text not null, ip_address inet,");
  assert.throws(() => assertAnonymousCapSecurity(mutated), /must not store raw IP addresses/);
});

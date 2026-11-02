import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

async function latestReservationMigration() {
  const names = (await readdir(new URL("../supabase/migrations/", import.meta.url)))
    .filter(name => name.endsWith(".sql"))
    .sort();
  let latest = null;
  for (const name of names) {
    const sql = await readFile(new URL("../supabase/migrations/" + name, import.meta.url), "utf8");
    if (/create\s+(?:or\s+replace\s+)?function\s+public\.hookengine_reserve_generation/i.test(sql)) {
      latest = { name, sql };
    }
  }
  assert.ok(latest, "a reservation RPC migration must exist");
  return latest;
}

function assertUsesRpcCost(source) {
  assert.doesNotMatch(source, /expectedCost/);
  assert.match(source, /const reservedCredits = reservationCredits\(reservation\);/);
  assert.doesNotMatch(source, /reservation\.credits_reserved\s*!==/);
}

test("Edge Function uses the authoritative cost returned by the latest reservation RPC", async () => {
  const edge = await readFile(new URL("../supabase/functions/hookengine-generate/index.ts", import.meta.url), "utf8");
  assertUsesRpcCost(edge);
  const latest = await latestReservationMigration();
  assert.match(latest.sql, /'credits_reserved'\s*,\s*v_cost/i);
});

test("mutation proof rejects reintroducing a locally calculated generation cost", async () => {
  const edge = await readFile(new URL("../supabase/functions/hookengine-generate/index.ts", import.meta.url), "utf8");
  assertUsesRpcCost(edge);
  const mutated = edge.replace(
    "const reservedCredits = reservationCredits(reservation);",
    "const expectedCost = payload.sourceMode === \"youtube_video\" ? 5 : 1;\n  const reservedCredits = reservation.credits_reserved;"
  );
  assert.notEqual(mutated, edge, "the mutation must alter the reservation-cost path");
  assert.throws(() => assertUsesRpcCost(mutated), /expectedCost/);
});

test("RPC-returned reservation costs are positive safe integers", () => {
  for (const credits_reserved of [1, 5, 7]) {
    assert.ok(Number.isSafeInteger(credits_reserved) && credits_reserved > 0);
  }
});

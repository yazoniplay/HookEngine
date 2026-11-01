import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const read = async path => await readFile(new URL(path, import.meta.url), "utf8");
const PRIVACY_PATH = "../account/privacy.html";
const TERMS_PATH = "../account/terms.html";
const MIGRATIONS_DIRECTORY = new URL("../supabase/migrations/", import.meta.url);
const RESERVATION_MIGRATION = "../supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql";
const PLAN_MIGRATION = "../supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql";
const GENERATE_FUNCTION = "../supabase/functions/hookengine-generate/index.ts";
const PUBLIC_POLICY_PATHS = [PRIVACY_PATH, TERMS_PATH];

function assertNoBannedPrivacyClaims(text) {
  const banned = /\b(?:never|always|guarantee(?:d|s)?|GDPR|encrypted|anonymous|train(?:ing|ed|s)?|sell|sold)\b|\bdeleted\s+after\s+\d+\s+days?\b/i;
  assert.doesNotMatch(text, banned, "public privacy copy contains a banned or unsupported claim");
}
function matchingParenEnd(source, openIndex) {
  let depth = 0;
  let quote = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" && source[i + 1] === "'" && quote) { i++; continue; }
    if (ch === "'") { quote = !quote; continue; }
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i;
  }
  throw new Error("Unclosed SQL parenthesis");
}
function splitSqlList(source) {
  const parts = [];
  let start = 0, depth = 0, quote = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" && source[i + 1] === "'" && quote) { i++; continue; }
    if (ch === "'") { quote = !quote; continue; }
    if (quote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(source.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(source.slice(start).trim());
  return parts;
}
function assertReservationDoesNotPersistSourceText(fn) {
  const insert = fn.match(/insert\s+into\s+public\.hookengine_generations\s*\(/i);
  assert.ok(insert, "reservation function must insert a generation row");
  const columnsOpen = fn.indexOf("(", insert.index);
  const columnsClose = matchingParenEnd(fn, columnsOpen);
  const valuesMatch = /\bvalues\s*\(/ig;
  valuesMatch.lastIndex = columnsClose + 1;
  const values = valuesMatch.exec(fn);
  assert.ok(values, "generation insert must have a VALUES clause");
  const valuesOpen = fn.indexOf("(", values.index);
  const valuesClose = matchingParenEnd(fn, valuesOpen);
  const columns = splitSqlList(fn.slice(columnsOpen + 1, columnsClose)).map(value => value.replace(/"/g, "").toLowerCase());
  const insertedValues = splitSqlList(fn.slice(valuesOpen + 1, valuesClose));
  const sourceTextIndex = columns.indexOf("source_text");
  assert.notEqual(sourceTextIndex, -1, "generation insert must name source_text");
  assert.equal(insertedValues.length, columns.length, "generation insert column and value counts must match");
  assert.equal(insertedValues[sourceTextIndex].trim().toLowerCase(), "null",
    "the current reservation definition must insert NULL into source_text");
}
async function latestReservationDefinition() {
  const filenames = (await readdir(MIGRATIONS_DIRECTORY)).filter(name => name.endsWith(".sql")).sort();
  let latest = null;
  for (const filename of filenames) {
    const sql = await readFile(new URL(filename, MIGRATIONS_DIRECTORY), "utf8");
    const declaration = /create\s+(?:or\s+replace\s+)?function\s+public\.hookengine_reserve_generation\s*\(/ig;
    let match;
    while ((match = declaration.exec(sql)) !== null) {
      const bodyStart = sql.indexOf("as $function$", match.index);
      assert.notEqual(bodyStart, -1, filename + ": reservation function body delimiter must exist");
      const end = sql.indexOf("$function$;", bodyStart + "as $function$".length);
      assert.notEqual(end, -1, filename + ": reservation function must terminate cleanly");
      latest = { filename, functionSql: sql.slice(match.index, end + "$function$;".length) };
    }
  }
  assert.ok(latest, "a migration must define hookengine_reserve_generation");
  return latest;
}

function assertPrivacyDisclosure(html) {
  assert.match(html, /Generated drafts are stored/i, "privacy page must plainly disclose generated draft storage");
  assert.doesNotMatch(
    html,
    /(?:we|hookengine)\s+(?:do not|don't|never)\s+(?:store|save|retain)\s+(?:your\s+)?(?:generated\s+)?drafts/i,
    "privacy page must not claim generated drafts are not stored"
  );
}

function assertPaidHistoryWording(html) {
  assert.match(html, /Free history[\s\S]{0,160}configured Free-plan window/i, "Free history window must be disclosed");
  assert.match(html, /Paid history[\s\S]{0,160}no age-based history cutoff/i, "paid history must not be assigned an unsupported expiry period");
  assert.match(html, /until account deletion/i, "paid history should be described as retained until account deletion");
  assert.doesNotMatch(html, /paid history[^<]{0,160}\b(?:30|60|90|180|365) days\b/i, "do not invent a paid-history retention period");
}

test("privacy policy accurately discloses source processing and draft storage", async () => {
  const [privacy, reservation, generate] = await Promise.all([
    read(PRIVACY_PATH), read(RESERVATION_MIGRATION), read(GENERATE_FUNCTION)
  ]);
  assertPrivacyDisclosure(privacy);
  assert.match(reservation, /v_source_hash\s*:=\s*encode\(extensions\.digest\(convert_to\(v_source_text,'UTF8'\),'sha256'\),'hex'\)/i);
  assert.match(reservation, /v_source_length\s*:=\s*char_length\(v_source_text\)/i);
  assert.match(reservation, /null,v_source_hash,v_source_length,'reserved'/i);
  const latest = await latestReservationDefinition();
  assertReservationDoesNotPersistSourceText(latest.functionSql);
  assert.match(generate, /p_source_text:\s*payload\.sourceMode\s*===\s*"text"\s*\?\s*payload\.text\.trim\(\)/);
  assert.match(generate, /SOURCE TEXT \(untrusted reference material\)/);
  assert.match(reservation, /outputs=case when p_status='completed' then coalesce\(p_outputs,'\{\}'::jsonb\) else '\{\}'::jsonb end/i);
  assert.match(privacy, /raw source text is not retained in HookEngine's generation records/i);
});

test("latest sorted migration reservation definition inserts NULL into source_text", async () => {
  const latest = await latestReservationDefinition();
  assert.equal(latest.filename, "20261031123000_hookengine_regeneration_cost_one_credit.sql");
  assertReservationDoesNotPersistSourceText(latest.functionSql);
});

test("public privacy pages reject every banned claim category", async () => {
  const [privacy, terms, landing] = await Promise.all([...PUBLIC_POLICY_PATHS.map(read), read("../index.html")]);
  for (const page of [privacy, terms]) assertNoBannedPrivacyClaims(page);
  const faq = landing.match(/<section class="section" id="faq">[\s\S]*?<\/section>/i)?.[0];
  assert.ok(faq, "public FAQ section must exist");
  assertNoBannedPrivacyClaims(faq);
  for (const claim of ["never", "always", "guarantee", "GDPR", "encrypted", "anonymous", "train", "training", "sell", "deleted after 90 days"]) {
    assert.throws(() => assertNoBannedPrivacyClaims(privacy + "\n<p>" + claim + "</p>"), /banned or unsupported claim/, "must reject: " + claim);
  }
});

test("older Free records are described as stored but hidden", async () => {
  const [privacy, landing] = await Promise.all([read(PRIVACY_PATH), read("../index.html")]);
  for (const page of [privacy, landing]) {
    assert.match(page, /Older Free-plan records remain stored[\s\S]{0,160}hidden/i);
    assert.match(page, /visibility cutoff does not delete them/i);
  }
});

test("privacy policy mutation proof rejects a false no-draft-storage claim", async () => {
  const privacy = await read(PRIVACY_PATH);
  assertPrivacyDisclosure(privacy);
  const falseClaim = privacy.replace(
    "Generated drafts are stored",
    "We do not store your drafts. Generated drafts are stored"
  );
  assert.notEqual(falseClaim, privacy, "mutation must alter the privacy page");
  assert.throws(
    () => assertPrivacyDisclosure(falseClaim),
    /privacy page must not claim generated drafts are not stored/,
    "the privacy test must fail if the page says drafts are not stored"
  );
});

test("privacy policy states only database-enforced history retention", async () => {
  const [privacy, privacyJs, planMigration] = await Promise.all([
    read(PRIVACY_PATH), read("../account/privacy.js"), read(PLAN_MIGRATION)
  ]);
  assertPaidHistoryWording(privacy);
  assert.match(privacyJs, /PLAN_CATALOG\.free\.historyDays/);
  assert.match(planMigration, /\('free','Free','weekly',5,3,1,1,array\[[^\]]+\],false,false,7,/i);
  assert.match(planMigration, /\('pro','Pro','monthly',300,30,3,null,array\[[^\]]+\],true,true,null,/i);
  assert.match(planMigration, /return v_history_days is null or p_created_at\s*>=\s*now\(\)\s*-\s*make_interval\(days\s*=>\s*v_history_days\)/i);
  assert.match(planMigration, /create policy "Users can read their own generation history"[\s\S]{0,400}hookengine_history_visible\(created_at\)/i);

});

test("paid-history mutation proof rejects an invented 90-day expiry", async () => {
  const privacy = await read(PRIVACY_PATH);
  const falseRetention = privacy.replace(
    "Pro and Lifetime plans have no age-based history cutoff in the database.",
    "Pro and Lifetime history is deleted after 90 days."
  );
  assert.notEqual(falseRetention, privacy, "mutation must alter the privacy page");
  assert.throws(
    () => assertPaidHistoryWording(falseRetention),
    /paid history must not be assigned an unsupported expiry period/,
    "the retention test must fail if a paid expiry period is invented"
  );
});

test("provider disclosure matches the configured generation paths", async () => {
  const [privacy, generate] = await Promise.all([read(PRIVACY_PATH), read(GENERATE_FUNCTION)]);
  for (const provider of ["Google Gemini", "Groq", "Ollama Cloud"]) assert.ok(privacy.includes(provider), provider + " must be disclosed");
  assert.match(generate, /runWithProviderFallback\(/);
  assert.match(generate, /name:\s*"Groq"/);
  assert.match(generate, /name:\s*"Ollama"/);
  assert.match(generate, /https:\/\/generativelanguage\.googleapis\.com/);
  assert.match(generate, /https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions/);
  assert.match(generate, /https:\/\/ollama\.com\/api\/chat/);
});

test("privacy page describes account-scoped records and available deletion behavior", async () => {
  const [privacy, accountHtml, migration] = await Promise.all([
    read(PRIVACY_PATH), read("../account/index.html"), read("../supabase/migrations/20261024155344_hookengine_usage_limits_history.sql")
  ]);
  assert.match(privacy, /does not provide a self-service control/i);
  assert.doesNotMatch(accountHtml, /delete\s+(?:history|account|generation)/i);
  assert.match(migration, /user_id uuid not null references auth\.users\(id\) on delete cascade/i);
});

test("terms page is explicitly a draft and links to the privacy policy", async () => {
  const terms = await read(TERMS_PATH);
  assert.match(terms, /DRAFT — NOT FINAL TERMS/i);
  assert.match(terms, /must be reviewed by a qualified legal professional/i);
  assert.match(terms, /href="privacy\.html"/);
  assert.match(terms, /checkout is currently disabled/i);
});

test("support address is defined once and is not fabricated", async () => {
  const [support, index, privacy, terms, accountHtml] = await Promise.all([
    read("../support.js"), read("../index.html"), read(PRIVACY_PATH), read(TERMS_PATH), read("../account/index.html")
  ]);
  assert.match(support, /export const SUPPORT_EMAIL = "";/);
  assert.match(support, /TODO\(owner\)/);
  assert.equal((support.match(/SUPPORT_EMAIL\s*=/g) || []).length, 1);
  for (const html of [index, privacy, terms]) {
    assert.match(html, /data-support-email/);
    assert.doesNotMatch(html, /example\.com/i);
    assert.doesNotMatch(html, /Support contact not configured/i);
  }
  assert.match(support, /link\.textContent = ""/);
  assert.match(support, /container\.hidden = true/);
  assert.match(index, /<details data-support-faq>/);
  assert.match(privacy, /<section data-support-section>/);
  assert.match(terms, /<section data-support-section>/);
  assert.match(accountHtml, /terms\.html/);
  assert.doesNotMatch(index, /support@example\.com/i);
});

test("empty support configuration hides FAQ, policy and footer contact surfaces", async () => {
  const source = await read("../support.js");
  const targets = [
    { container: { hidden: false } },
    { container: { hidden: false } },
    { container: { hidden: false } },
    { container: null }
  ];
  const links = targets.map(({ container }) => ({
    textContent: "placeholder",
    href: "mailto:placeholder",
    hidden: false,
    removeAttribute(name) { if (name === "href") delete this.href; },
    closest() { return container; }
  }));
  runInNewContext(source.replace("export const SUPPORT_EMAIL", "const SUPPORT_EMAIL"), {
    document: { querySelectorAll: () => links }
  });
  assert.ok(targets.slice(0, 3).every(item => item.container.hidden));
  assert.equal(links[3].hidden, true);
  assert.ok(links.every(link => link.textContent === ""));
  assert.ok(links.every(link => !("href" in link)));
});

test("privacy policy discloses extension local and Chrome sync storage", async () => {
  const [privacy, background, settings, config] = await Promise.all([
    read(PRIVACY_PATH), read("../background.js"), read("../settings.js"), read("../extension/config.js")
  ]);
  assert.match(privacy, /chrome\.storage\.local/i);
  assert.match(privacy, /chrome\.storage\.sync/i);
  assert.match(privacy, /saved sign-in session/i);
  assert.match(privacy, /most recent generation result/i);
  assert.match(privacy, /writing preferences/i);
  assert.match(background, /chrome\.storage\.local\.set\(\{ \[STORAGE_KEYS\.lastGeneration\]/);
  assert.match(settings, /chrome\.storage\.sync\.set/);
  assert.match(config, /session: "hookengine-account-session"/);
  assert.match(config, /lastGeneration: "hookengine-last-generation"/);
  assert.match(config, /writingPreferences: "hookengine-writing-preferences"/);
});

test("landing FAQ has no internal audit notes and links to draft terms", async () => {
  const html = await read("../index.html");
  assert.doesNotMatch(html, /TODO: Clarify source|current policy does not clearly explain|TODO: Confirm retention/i);
  assert.match(html, /account\/terms\.html/);
  assert.match(html, /Free history follows the Free plan\x27s configured history window/i);
  assert.match(html, /Paid-plan history has no automatic age-based expiry/i);
});

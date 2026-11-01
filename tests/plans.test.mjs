import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PLAN_CATALOG, CREDIT_COSTS, formatPlanPrice, formatPlanPeriod, planSummary } from "../extension/plans.js";

const MIGRATION_PATH = "../supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql";
const STATIC_HTML_PATHS = [
  "../index.html",
  "../popup.html",
  "../settings.html",
  "../sidepanel.html",
  "../account/index.html",
  "../account/privacy.html"
];

function parseSqlLiteral(value) {
  const token = value.trim();
  if (token.toLowerCase() === "null") return null;
  if (token.toLowerCase() === "true") return true;
  if (token.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(token)) return Number(token);
  if (token.startsWith("array[") && token.endsWith("]")) {
    return token.slice(6, -1).split(",").map(item => item.trim().replace(/^'|'$/g, ""));
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
  throw new Error("Unsupported SQL seed literal: " + token);
}

function parsePlanSeed(sql) {
  const match = sql.match(/insert\s+into\s+public\.hookengine_plans\s*\(([\s\S]*?)\)\s*values\s*([\s\S]*?)\s*on\s+conflict/i);
  assert.ok(match, "plan seed INSERT block exists in migration");
  const columns = match[1].split(",").map(column => column.trim());
  const valuesText = match[2];
  const tuples = [];
  let tuple = "";
  let depth = 0;
  let bracketDepth = 0;
  let inString = false;
  let fields = [];
  for (let i = 0; i < valuesText.length; i++) {
    const char = valuesText[i];
    if (char === "'" && valuesText[i + 1] === "'" && inString) { tuple += "''"; i++; continue; }
    if (char === "'") inString = !inString;
    if (!inString) {
      if (char === "(" && depth === 0) { depth = 1; fields = []; tuple = ""; continue; }
      if (char === "[" ) bracketDepth++;
      if (char === "]") bracketDepth--;
      if (char === "," && depth === 1 && bracketDepth === 0) { fields.push(tuple); tuple = ""; continue; }
      if (char === ")" && depth === 1) {
        fields.push(tuple);
        tuples.push(fields.map(parseSqlLiteral));
        depth = 0; tuple = ""; continue;
      }
    }
    if (depth === 1) tuple += char;
  }
  return tuples.map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

function catalogSeedShape(catalog) {
  return Object.fromEntries(Object.entries(catalog).map(([key, plan]) => [key, {
    plan_key: key,
    display_name: plan.label,
    billing_interval: plan.billingInterval,
    credits_per_period: plan.credits,
    daily_generation_limit: plan.dailyGenerations,
    versions_per_generation: plan.variations,
    regenerations_per_generation: plan.regenerationsPerSource,
    platform_keys: [...plan.platforms],
    voice_enabled: plan.voiceEnabled,
    video_enabled: plan.videoEnabled,
    history_days: plan.historyDays,
    trial_days: plan.trialDays,
    trial_credit_limit: plan.trialCreditLimit,
    lifetime_spot_limit: plan.lifetimeSpots,
    price_minor: plan.priceMinor,
    price_currency: plan.currency,
    is_active: plan.isActive
  }]));
}

function assertPlanSeedMatchesCatalog(sql, catalog = PLAN_CATALOG) {
  const actual = Object.fromEntries(parsePlanSeed(sql).map(row => [row.plan_key, row]));
  assert.deepEqual(actual, catalogSeedShape(catalog), "database plan seed must exactly match PLAN_CATALOG");
}

function assertNoHardcodedPlanNumbers(html, filePath = "static HTML") {
  const customerMarkup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "");
  const planQuantity = /\b\d+\s*(?:credits?|generations?|platforms?|days?|spots?|variations?|versions?)\b|\b\d+\s*-\s*(?:day|week|month)\b/i;
  const planPrice = /(?:€\s*\d+(?:[.,]\d{1,2})?|\b\d+(?:[.,]\d{1,2})?\s*€|\bEUR\s*\d+(?:[.,]\d{1,2})?)/i;
  assert.doesNotMatch(customerMarkup, planQuantity, filePath + " must not hardcode plan quantities");
  assert.doesNotMatch(customerMarkup, planPrice, filePath + " must not hardcode plan prices");
}

test("shared catalog matches the published plan contract", () => {
  assert.deepEqual({credits:PLAN_CATALOG.free.credits,daily:PLAN_CATALOG.free.dailyGenerations,platforms:PLAN_CATALOG.free.platforms.length,history:PLAN_CATALOG.free.historyDays},{credits:5,daily:3,platforms:3,history:7});
  assert.deepEqual({credits:PLAN_CATALOG.trial.credits,days:PLAN_CATALOG.trial.trialDays,daily:PLAN_CATALOG.trial.dailyGenerations,variations:PLAN_CATALOG.trial.variations},{credits:40,days:7,daily:30,variations:3});
  assert.deepEqual({credits:PLAN_CATALOG.pro.credits,daily:PLAN_CATALOG.pro.dailyGenerations,platforms:PLAN_CATALOG.pro.platforms.length,variations:PLAN_CATALOG.pro.variations},{credits:300,daily:30,platforms:6,variations:3});
  assert.equal(PLAN_CATALOG.lifetime.credits,150);
  assert.equal(PLAN_CATALOG.lifetime.lifetimeSpots,50);
  assert.equal(PLAN_CATALOG.lifetime.priceMinor,null);
  assert.equal(formatPlanPrice("lifetime"),"Price not set");
  assert.equal(formatPlanPrice("pro"),"€4.99");
  assert.equal(formatPlanPeriod("pro"),"/ month");
  assert.deepEqual(CREDIT_COSTS,{article:1,youtubeVideo:5,regeneration:1,videoRegeneration:5});
});

test("migration plan seed exactly matches PLAN_CATALOG", async () => {
  const migration = await readFile(new URL(MIGRATION_PATH, import.meta.url), "utf8");
  assertPlanSeedMatchesCatalog(migration);

  const mutatedMigration = migration.replace(
    "('free','Free','weekly',5,3,1,1,",
    "('free','Free','weekly',6,3,1,1,"
  );
  assert.notEqual(mutatedMigration, migration, "mutation changes the SQL seed");
  assert.throws(
    () => assertPlanSeedMatchesCatalog(mutatedMigration),
    /database plan seed must exactly match PLAN_CATALOG/,
    "changing a seeded plan credit value must fail the comparison"
  );
});

test("static HTML contains no hardcoded plan quantities or prices", async () => {
  const htmlFiles = await Promise.all(STATIC_HTML_PATHS.map(async path => ({
    path,
    html: await readFile(new URL(path, import.meta.url), "utf8")
  })));
  for (const {path, html} of htmlFiles) assertNoHardcodedPlanNumbers(html, path);

  const landing = htmlFiles.find(file => file.path === "../index.html").html;
  const mutatedLanding = landing.replace(
    "Multiple variations in Pro",
    "3 variations in Pro"
  );
  assert.notEqual(mutatedLanding, landing, "mutation inserts a hardcoded plan quantity");
  assert.throws(
    () => assertNoHardcodedPlanNumbers(mutatedLanding, "../index.html"),
    /must not hardcode plan quantities/,
    "reintroducing a hardcoded plan quantity in static HTML must fail"
  );
});

test("landing, account portal and popup use the shared catalog", async () => {
  const [landing,landingJs,accountHtml,accountJs,popupHtml,sidepanel] = await Promise.all([
    readFile(new URL("../index.html",import.meta.url),"utf8"),
    readFile(new URL("../landing.js",import.meta.url),"utf8"),
    readFile(new URL("../account/index.html",import.meta.url),"utf8"),
    readFile(new URL("../account/account.js",import.meta.url),"utf8"),
    readFile(new URL("../popup.html",import.meta.url),"utf8"),
    readFile(new URL("../sidepanel.js",import.meta.url),"utf8")
  ]);
  assert.match(landing,/data-plan-summary="free"/);
  assert.match(landing,/data-plan-price="pro"/);
  assert.match(landing,/data-plan-features="free"/);
  assert.match(landingJs,/from "\.\/extension\/plans\.js"/);
  assert.match(accountHtml,/type="module" src="account\.js"/);
  assert.match(accountHtml,/id="planPricingGrid"/);
  assert.ok(accountJs.includes('from "../extension/plans.js"'));
  assert.match(accountJs,/function renderPlanCards\(\)/);
  assert.match(accountJs,/renderPlanCards\(\);/);
  assert.match(accountJs,/planPricingGrid/);
  assert.match(popupHtml,/id="authPlanSummary"/);
  assert.match(sidepanel,/from "\.\/extension\/plans\.js"/);
  assert.doesNotMatch(landing,/5 generations per day|100 generations per day/i);
  assert.doesNotMatch(landing,/"price":"4\.99"/i);
  assert.doesNotMatch(accountHtml,/5 credits each week · 3 generations per day/i);
  assert.doesNotMatch(accountHtml,/7-day Pro trial or 40 credits/);
  assert.match(landingJs,/schemaNode/);
  assert.equal(planSummary("free"),"5 credits per UTC week · up to 3 generations per UTC day · 3 platforms · 7-day history");
});

test("landing loads plan rendering from a local module", async () => {
  const html=await readFile(new URL("../index.html",import.meta.url),"utf8");
  const script=await readFile(new URL("../landing.js",import.meta.url),"utf8");
  assert.match(html,/<script type="module" src="landing\.js"><\/script>/);
  assert.match(script,/formatPlanPrice/);
  assert.match(script,/planSummary/);
  assert.match(script,/planFeatures/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PLAN_CATALOG, CREDIT_COSTS, formatPlanPrice, formatPlanPeriod, planSummary } from "../extension/plans.js";
test("shared catalog matches published plan entitlements",()=>{
 assert.deepEqual({credits:PLAN_CATALOG.free.credits,daily:PLAN_CATALOG.free.dailyGenerations,platforms:PLAN_CATALOG.free.platforms.length,history:PLAN_CATALOG.free.historyDays},{credits:5,daily:3,platforms:3,history:7});
 assert.deepEqual({credits:PLAN_CATALOG.trial.credits,days:PLAN_CATALOG.trial.trialDays,daily:PLAN_CATALOG.trial.dailyGenerations,variations:PLAN_CATALOG.trial.variations},{credits:40,days:7,daily:30,variations:3});
 assert.deepEqual({credits:PLAN_CATALOG.pro.credits,daily:PLAN_CATALOG.pro.dailyGenerations,platforms:PLAN_CATALOG.pro.platforms.length,variations:PLAN_CATALOG.pro.variations},{credits:300,daily:30,platforms:6,variations:3});
 assert.equal(PLAN_CATALOG.lifetime.credits,150);assert.equal(PLAN_CATALOG.lifetime.lifetimeSpots,50);assert.equal(PLAN_CATALOG.lifetime.priceMinor,null);
 assert.equal(formatPlanPrice("lifetime"),"Price not set");assert.equal(formatPlanPrice("pro"),"€4.99");assert.equal(formatPlanPeriod("pro"),"/ month");
 assert.deepEqual(CREDIT_COSTS,{article:1,youtubeVideo:5,regeneration:1,videoRegeneration:5});
});
test("landing, account portal and popup use the shared catalog",async()=>{
 const [landing,landingJs,accountHtml,accountJs,popupHtml,sidepanel]=await Promise.all([
  readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../landing.js",import.meta.url),"utf8"),
  readFile(new URL("../account/index.html",import.meta.url),"utf8"),readFile(new URL("../account/account.js",import.meta.url),"utf8"),
  readFile(new URL("../popup.html",import.meta.url),"utf8"),readFile(new URL("../sidepanel.js",import.meta.url),"utf8")]);
 assert.match(landing,/data-plan-summary="free"/);assert.match(landing,/data-plan-price="pro"/);assert.match(landing,/data-plan-features="free"/);
 assert.match(landingJs,/from ".\/extension\/plans\.js"/);
 assert.match(accountHtml,/type="module" src="account\.js"/);assert.match(accountHtml,/id="planPricingGrid"/);
 assert.ok(accountJs.includes('from "../extension/plans.js"'));assert.match(accountJs,/renderPlanCards\(\)/);
 const startupIifeIndex=accountJs.lastIndexOf("(async()=>{"),upgradeHandlerIndex=accountJs.lastIndexOf('$("upgradeBtn").addEventListener');
 const startupCallIndex=accountJs.lastIndexOf("renderPlanCards();");
 assert.ok(startupCallIndex>upgradeHandlerIndex&&startupCallIndex<startupIifeIndex,"account pricing cards render before sign-in");
 const brokenAccountJs=accountJs.slice(0,startupCallIndex)+accountJs.slice(startupCallIndex+"renderPlanCards();".length);
 const brokenIifeIndex=brokenAccountJs.lastIndexOf("(async()=>{"),brokenUpgradeIndex=brokenAccountJs.lastIndexOf('$("upgradeBtn").addEventListener'),brokenCallIndex=brokenAccountJs.lastIndexOf("renderPlanCards();");
 assert.throws(()=>assert.ok(brokenCallIndex>brokenUpgradeIndex&&brokenCallIndex<brokenIifeIndex),/The expression evaluated to a falsy value/,"removing startup rendering must fail the assertion");
 assert.match(popupHtml,/id="authPlanSummary"/);assert.match(sidepanel,/from ".\/extension\/plans\.js"/);
 assert.doesNotMatch(landing,/5 generations per day|100 generations per day/i);
 assert.doesNotMatch(landing,/"price":"4\.99"/i);
 assert.doesNotMatch(accountHtml,/5 credits each week · 3 generations per day/i);
 assert.doesNotMatch(accountHtml,/7-day Pro trial or 40 credits/);assert.match(landingJs,/schemaNode/);

 assert.equal(planSummary("free"),"5 credits per UTC week · up to 3 generations per UTC day · 3 platforms · 7-day history");
 const broken=landing.replace('<span data-plan-summary="free"></span>',"5 generations per day");
 assert.notEqual(broken,landing);
 assert.throws(()=>assert.doesNotMatch(broken,/5 generations per day|100 generations per day/i),/The input was expected to not match the regular expression/,"reintroducing stale landing copy must fail");
});
test("landing loads plan rendering from a local module",async()=>{
 const html=await readFile(new URL("../index.html",import.meta.url),"utf8"),script=await readFile(new URL("../landing.js",import.meta.url),"utf8");
 assert.match(html,/<script type="module" src="landing\.js"><\/script>/);assert.match(script,/formatPlanPrice/);assert.match(script,/planSummary/);assert.match(script,/planFeatures/);
});

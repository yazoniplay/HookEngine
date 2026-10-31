import test from "node:test";
import assert from "node:assert/strict";
import { creditUsageLabel, creditUsagePercent, dailyLimitLine, planLabel, usageMainLine } from "../extension/usage-display.mjs";

test("Free plan shows remaining weekly sources and Monday reset", () => {
  assert.equal(usageMainLine({
    plan: "free", credits: 2, creditsTotal: 5,
    resetAt: "2026-11-02T00:00:00Z",
  }), "2 of 5 credits left this week · resets Monday");
  assert.equal(planLabel("free"), "Free");
});

test("Trial shows remaining credits and days", () => {
  const now = Date.parse("2026-10-31T00:00:00Z");
  assert.equal(usageMainLine({
    plan: "trial", credits: 31, creditsTotal: 40,
    trialEndsAt: "2026-11-05T00:00:00Z",
  }, now), "Pro trial: 31 of 40 credits left · 5 days left");
  assert.equal(planLabel("trial"), "Trial");
});

test("daily cap line is hidden until one use remains", () => {
  assert.equal(dailyLimitLine({ dailyLimit: 3, remainingDaily: 2, dailyUsed: 1 }), "");
});

test("daily cap line warns when one use remains", () => {
  assert.equal(dailyLimitLine({
    dailyLimit: 3, remainingDaily: 1, dailyUsed: 2,
    resetAtDay: "2026-11-01T00:00:00Z",
  }), "Daily limit nearly reached (2/3) · resets at 00:00 UTC");
});

test("daily cap line names the reached limit and exact UTC reset", () => {
  assert.equal(dailyLimitLine({
    dailyLimit: 3, remainingDaily: 0, dailyUsed: 3,
    resetAtDay: "2026-11-01T00:00:00Z",
  }), "Daily limit reached (3/3) · resets at 00:00 UTC");
});

test("Pro plan shows its monthly balance and reset date", () => {
  assert.equal(usageMainLine({
    plan: "pro", period: "month", credits: 299, creditsTotal: 300,
    resetAt: "2026-11-01T00:00:00Z",
  }), "299 of 300 credits left this month · resets Nov 1");
  assert.equal(planLabel("pro"), "Pro");
});

test("credit meter reports used credits and clamps progress", () => {
  const usage = { plan: "free", credits: 2, creditsTotal: 5 };
  assert.equal(creditUsageLabel(usage), "3 of 5 credits used this week");
  assert.equal(creditUsagePercent(usage), 60);
  assert.equal(creditUsagePercent({ credits: 9, creditsTotal: 5 }), 0);
  assert.equal(creditUsagePercent({ credits: -2, creditsTotal: 5 }), 100);
  assert.equal(creditUsagePercent({ credits: 1, creditsTotal: 0 }), 0);
});

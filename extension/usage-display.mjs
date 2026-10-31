export function planLabel(plan) {
  return ({ free: "Free", pro: "Pro", trial: "Trial", lifetime: "Lifetime" })[plan] || "Free";
}

export function usageMainLine(usage, now = Date.now()) {
  if (usage.plan === "trial") {
    const end = usage.trialEndsAt ? new Date(usage.trialEndsAt).getTime() : NaN;
    const daysLeft = Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 86400000)) : 0;
    return "Pro trial: " + usage.credits + " of " + usage.creditsTotal +
      " credits left · " + daysLeft + (daysLeft === 1 ? " day left" : " days left");
  }
  if (usage.plan === "free") {
    const reset = usage.resetAt ? new Date(usage.resetAt) : null;
    const resetDay = reset && Number.isFinite(reset.getTime())
      ? reset.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
      : "Monday";
    return usage.credits + " of " + usage.creditsTotal +
      " credits left this week · resets " + resetDay;
  }
  const periodLabel = ["month", "monthly"].includes(usage.period) ? "this month" : "this period";
  const reset = usage.resetAt ? new Date(usage.resetAt) : null;
  const resetDate = reset && Number.isFinite(reset.getTime())
    ? reset.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "at the period reset";
  return usage.credits + " of " + usage.creditsTotal +
    " credits left " + periodLabel + " · resets " + resetDate;
}

export function dailyLimitLine(usage) {
  if (!usage.dailyLimit || usage.remainingDaily > 1) return "";
  const reset = usage.resetAtDay ? new Date(usage.resetAtDay) : null;
  const resetTime = reset && Number.isFinite(reset.getTime())
    ? reset.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    : "00:00";
  if (usage.dailyUsed >= usage.dailyLimit) {
    return "Daily limit reached (" + usage.dailyUsed + "/" + usage.dailyLimit + ") · resets at " + resetTime + " UTC";
  }
  return "Daily limit nearly reached (" + usage.dailyUsed + "/" + usage.dailyLimit + ") · resets at " + resetTime + " UTC";
}

export function creditUsagePercent(usage) {
  const total = Number(usage?.creditsTotal);
  const remaining = Number(usage?.credits);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) return 0;
  return Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
}

export function creditUsageLabel(usage) {
  const total = Math.max(0, Number(usage?.creditsTotal) || 0);
  const remaining = Math.min(total, Math.max(0, Number(usage?.credits) || 0));
  const used = total - remaining;
  const period = usage?.plan === "free" ? "this week" : usage?.plan === "trial" ? "in your trial" : "this month";
  return used + " of " + total + " credits used " + period;
}

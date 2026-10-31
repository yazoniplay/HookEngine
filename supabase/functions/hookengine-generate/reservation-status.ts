const LIMIT_REASONS = new Set([
  "daily_cap",
  "daily_limit_reached",
  "weekly_limit",
  "monthly_limit",
  "insufficient_credits",
  "too_many_pending"
]);

const FEATURE_REASONS = new Set([
  "feature_locked",
  "video_not_included",
  "platform_not_included",
  "trial_expired",
  "regeneration_limit_reached"
]);

export function reservationHttpStatus(reason: string): number {
  if (LIMIT_REASONS.has(reason)) return 429;
  if (FEATURE_REASONS.has(reason)) return 403;
  return 400;
}

export function reservationLimitReached(reason: string): boolean {
  return LIMIT_REASONS.has(reason);
}

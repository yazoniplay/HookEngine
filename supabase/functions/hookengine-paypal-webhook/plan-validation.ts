export type PayPalPlanCheck =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "wrong_plan" };

export function validatePayPalProPlanId(resource: unknown, configuredPlanId: string): PayPalPlanCheck {
  const expected = configuredPlanId.trim();
  if (!expected) return { ok: false, reason: "not_configured" };
  const actual = resource && typeof resource === "object"
    ? String((resource as Record<string, unknown>).plan_id || "").trim()
    : "";
  if (!actual || actual !== expected) return { ok: false, reason: "wrong_plan" };
  return { ok: true };
}

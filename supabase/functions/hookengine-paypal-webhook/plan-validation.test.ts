import { assertEquals } from "jsr:@std/assert";
import { validatePayPalProPlanId } from "./plan-validation.ts";

Deno.test("rejects activation when the expected Pro plan ID is not configured", () => {
  assertEquals(validatePayPalProPlanId({ plan_id: "P-PRO" }, ""), {
    ok: false,
    reason: "not_configured",
  });
});

Deno.test("rejects a different PayPal plan ID", () => {
  assertEquals(validatePayPalProPlanId({ plan_id: "P-WRONG" }, "P-PRO"), {
    ok: false,
    reason: "wrong_plan",
  });
});

Deno.test("accepts only the configured PayPal Pro plan ID", () => {
  assertEquals(validatePayPalProPlanId({ plan_id: "P-PRO" }, "P-PRO"), { ok: true });
});

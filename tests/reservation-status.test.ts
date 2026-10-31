import { assertEquals } from "jsr:@std/assert@1";
import { reservationHttpStatus, reservationLimitReached } from "../supabase/functions/hookengine-generate/reservation-status.ts";

Deno.test("weekly, monthly and daily limits return HTTP 429", () => {
  for (const reason of ["weekly_limit", "monthly_limit", "daily_cap", "daily_limit_reached", "insufficient_credits", "too_many_pending"]) {
    assertEquals(reservationHttpStatus(reason), 429, reason);
    assertEquals(reservationLimitReached(reason), true, reason);
  }
});

Deno.test("feature restrictions return HTTP 403", () => {
  for (const reason of ["feature_locked", "video_not_included", "platform_not_included", "trial_expired", "regeneration_limit_reached"]) {
    assertEquals(reservationHttpStatus(reason), 403, reason);
    assertEquals(reservationLimitReached(reason), false, reason);
  }
});

Deno.test("unknown reservation errors return HTTP 400", () => {
  assertEquals(reservationHttpStatus("invalid_cost"), 400);
  assertEquals(reservationLimitReached("invalid_cost"), false);
});

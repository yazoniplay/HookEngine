# HookEngine Phase 2 — status

**Status:** Phase 2 implementation is merged and deployed; external end-to-end acceptance tests remain outstanding.  
**Checked:** 2026-10-31  
**Extension manifest:** 1.7.0 (unchanged)  
**Production functions:** `hookengine-generate` v19, `hookengine-admin-plan` v5, `hookengine-paypal-webhook` v10 — ACTIVE  
**Checkout:** disabled  
**Phase 3:** not started

## Production state

- Plan/credit entitlements, UTC daily and billing-period resets, reservation refusal messages, internal-account Lifetime protection, audit table, corrected unpriced-generation metric, and PayPal refund/reversal handling are applied.
- Admin account remains Pro with `lifetime_claimed_at = NULL`; production Lifetime claimed count is 0.
- RLS is enabled on all nine HookEngine tables. Anon has no table access. Authenticated has SELECT only on generations, plans, profiles and subscriptions; no browser write grants exist.
- Reservation, finish, admin, PayPal event and maintenance routines are service-role-only. The two usage RPCs and history visibility helper are SECURITY INVOKER and authenticated-readable.
- Maintenance jobs are active: reservation cleanup every minute, trial expiry at minute 5 hourly, source retention at 03:25 UTC daily.
- Current owner usage RPC: Pro, 299/300 balance, 1 current-period credit used, 2 historical credits consumed across 19 completed generations, 7,854 recorded tokens, one fully metered generation.

## Verified tests

- GitHub Actions: Phase 2 validation, Extension tests and full-history secret scan passed on commit `c9b3ff48d2a14150e4af58105afd4db082163287`.
- PostgreSQL CI applies the full migration chain and passes entitlement, reservation/refund, RLS/grant, reset-message, admin audit privilege, Lifetime allocation, PayPal cancellation/payment-failure/refund/replay tests.
- Rollback-only production SQL tests passed for Free/Trial usage snapshots, exact daily and weekly refusal messages, stale-reservation refund, trial expiry, PayPal cancel/payment-failure/refund/replay, and failed five-credit video reservation refund.
- Deno tests passed for normal-user admin denial with audit write, invalid session audit, PayPal forged/valid signature verification behavior, and Pro plan-ID validation.
- Extension tests passed for the Free/Trial/Pro usage copy and plan tag.

## Still outstanding

- No live authenticated generation request through production `hookengine-generate`; live provider/token telemetry, Gemini fallback and video-provider failure remain unverified.
- Admin normal-user denial is tested against mocked Auth in CI; no live normal-user JWT request or production audit row has been recorded.
- No real PayPal sandbox delivery or forged HTTP request has been tested. `PAYPAL_PRO_PLAN_ID` configuration has not been independently confirmed.
- Source-retention cron is active but has not reached its first scheduled run yet.
- Supabase Auth leaked-password protection remains disabled per the security advisor; enable it in Dashboard → Authentication → Password Security.

Checkout remains disabled. Do not begin Phase 3 until the remaining external checks are completed and the user approves.

## Pull requests

- PR #35 merged: admin audit, Lifetime inventory guard, telemetry metric correction.
- PR #36 merged: final popup usage display, test coverage, PayPal signature/refund handling and verification report.
- PR #34 remains unmerged, as requested.

See [PHASE2-VERIFICATION-REPORT.md](./PHASE2-VERIFICATION-REPORT.md) for query outputs, raw usage JSON, cron results, detailed privilege tables and the full outstanding-test list. See [PHASE2-DIAGNOSTICS.sql](./PHASE2-DIAGNOSTICS.sql) for repeatable database audit queries.

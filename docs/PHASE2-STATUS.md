# HookEngine Phase 2 — production closeout

**Status:** Phase 2 implementation deployed. No Phase 3 work is included here.
**Extension version:** 1.7.0 (unchanged)
**Production Edge Function:** `hookengine-generate` v19 (ACTIVE)

## Deployed database migrations

- `20261031012059_hookengine_plan_credits_entitlements`
- `20261031075000_hookengine_usage_reporting_admin_entitlements`
- `20261031082226_hookengine_phase2_spec_alignment`
- `20261031082443_hookengine_regeneration_cost_one_credit`

The last migration corrects regeneration pricing: every regeneration costs 1 credit; a first full-video analysis costs 5 credits.

## Entitlements

| Plan | Period allowance | Daily cap | Versions | Regenerations/source | History |
|---|---:|---:|---:|---:|---:|
| Free | 5 / UTC week | 3 | 1 | 1 | 7 days |
| Trial | 40 credits or 7 days | 30 | 3 | Unlimited within credits | Unlimited |
| Pro | 300 / UTC month | 30 | 3 | Unlimited within credits | Unlimited |
| Lifetime | 150 / UTC month | 30 | 3 | Unlimited within credits | Unlimited |

- Free week starts Monday at 00:00 UTC.
- Monthly allowances reset at the start of the UTC calendar month.
- Trial expires at 7 days or when its 40 credits are exhausted.
- Lifetime allocation is capped at 50 accounts.
- Text/article/transcript generation costs 1 credit; first full-video analysis costs 5; every regeneration costs 1.
- The plan table is the source of truth; client usage reads use `hookengine_my_usage()`.
- Pro and Lifetime prices remain unset pending Phase 5 billing. The retired PayPal checkout is disabled; no purchase flow is currently available.

## Security and privacy checks

- RLS is enabled on all HookEngine tables.
- Authenticated users have SELECT grants only on the four user-facing tables; policies scope profile, subscription and generation history to the signed-in user. There are no browser-role write grants on HookEngine tables.
- Reservation, finish, admin, PayPal event and maintenance RPCs are executable only by `service_role`.
- `hookengine_my_usage()` and the compatibility wrapper `hookengine_get_usage()` are SECURITY INVOKER and available to authenticated users only.
- `hookengine_credit_ledger`, `hookengine_model_rates` and `hookengine_paypal_webhook_events` intentionally have RLS enabled with no browser policies. This is deny-by-default; server-side service-role/definer code handles access.
- New generations store source SHA-256 and character length, not source text. Existing source text was cleared.
- Production check: 22 generation rows, 0 with source text, 0 missing source hashes/lengths, 0 stuck reservations.
- Maintenance jobs are active: reservation cleanup every minute, trial expiry hourly, source-retention cleanup daily at 03:25 UTC.

## Verification performed

- Applied the Phase 2 migrations to production.
- Ran the PostgreSQL entitlement test suite and Phase 2 migration inside a transaction against the production schema, then rolled back the test transaction.
- Ran a separate transcript reservation/finalization smoke test inside a transaction and rolled it back.
- Ran six concurrent reservation RPC calls against a temporary synthetic Free account. Exactly two were admitted while pending; four were rejected as `too_many_pending`, matching the two-pending-reservation rule. The temporary account was deleted afterwards.
- Verified Monday-based UTC and monthly UTC window calculations from the deployed credit-period function.
- Verified Gemini 3.5 Flash-Lite is a listed stable model and confirmed its current standard paid-tier prices ($0.30 input / $2.50 output per million tokens). The database rate row points to Google's pricing page and records its verification timestamp.
- Confirmed deployed generation Edge Function v19 is ACTIVE.

## Remaining manual / external checks

1. **Supabase Auth hardening:** the Supabase security advisor still reports leaked-password protection disabled. Enable it in the Supabase Dashboard under Authentication / Password Security. This is an account-level setting; it was not changed by the database migration.
2. **CI status:** the GitHub connector did not return workflow-run/check results for the merged Phase 2 commits, so CI is not marked as verified in this closeout. The repository workflow includes Deno checks and PostgreSQL migration tests.
3. **Provider end-to-end:** the database reservation/finish paths were tested, but a fresh live AI-provider generation against Edge Function v19 was not performed as part of this closeout.
4. **Billing sandbox:** no real PayPal sandbox checkout/webhook cycle was tested. Checkout is deliberately disabled until Phase 5 replaces it with the new billing flow.

See [PHASE2-DIAGNOSTICS.sql](./PHASE2-DIAGNOSTICS.sql) for repeatable production audit queries.

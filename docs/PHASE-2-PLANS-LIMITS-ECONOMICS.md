# HookEngine Phase 2 — Plans, Limits & Economics

## Status

Implementation branch: `phase-2-plans-limits-economics`

Phase 0 and Phase 1 are treated as complete. Phase 2 is isolated from `main` until reviewed and merged.

## Canonical plan model

| Plan | Credit allowance | Daily cap | Versions | Regenerations | Platforms | History |
|---|---:|---:|---:|---:|---:|---|
| Free | 5 / UTC week | 3 | 1 | 1 per source | 3 | 7 days |
| Pro | 300 / UTC month | 30 | 3 | Unlimited within credits | 6 | Unlimited |
| Trial | 40 total, expires after 7 days | 30 | 3 | Unlimited within credits | 6 | Unlimited |
| Lifetime | 150 / UTC month | 30 | 3 | Unlimited within credits | 6 | Unlimited |

New signups receive the trial. Existing accounts are not silently upgraded; they retain their existing Free or Pro state.

The Lifetime entitlement is capped at 50 accounts. Its price is intentionally unset until unit economics are validated. Pro retains the existing €4.99/month placeholder.

## Credit costs

- Article text or transcript generation: 1 credit.
- Video analysis: 5 credits.
- Article/text regeneration: 1 credit.
- YouTube video regeneration: 5 credits because the video analysis pipeline runs again.

The database reservation RPC is authoritative. It checks the UTC daily cap, available credits, platform entitlements, video access, regeneration allowance and pending-reservation limit in one transaction under a per-user advisory lock. Regeneration must reference the original completed generation and must match its source type, URL and stored text; regenerated drafts cannot become new regeneration parents.

Failed requests refund reserved credits. Reservations older than five minutes are failed and refunded by the cleanup job. At most two active recent reservations are allowed per user.

## Cost measurement

Generation rows record provider, model, input tokens, output tokens, latency, reserved credits and estimated provider cost. The cost estimate is calculated from the editable `hookengine_model_rates` table.

The initial Gemini 3.5 Flash-Lite rate is based on Google's published standard API pricing:
- Input: USD 0.30 / 1M tokens.
- Output: USD 2.50 / 1M tokens.

These are provider-list-price estimates, not invoice-level charges. Other providers remain unpriced until their applicable rates are verified; the system leaves their estimated cost null rather than inventing a rate.

## Database responsibilities

- `hookengine_plans`: canonical plan entitlements and editable pricing fields.
- `hookengine_subscriptions`: current plan, trial window, credit balance and UTC credit period.
- `hookengine_credit_ledger`: immutable grants, reservations, refunds and period expirations.
- `hookengine_model_rates`: editable provider/model rates.
- `hookengine_reserve_generation`: atomic entitlement and credit reservation.
- `hookengine_finish_generation`: completion, failure refund and usage telemetry.
- `hookengine_get_usage`: authenticated account usage snapshot.
- `hookengine_cleanup_reservations` and `hookengine_expire_trials`: scheduled maintenance.

RLS is enabled on plan, ledger and rate tables. Browser roles receive no direct read/write access to those tables. Generation history visibility is filtered by the current plan.

## Deployment order

1. Review and validate this migration and the generation Edge Function together. CI applies the full migration sequence to a clean PostgreSQL instance with pg_cron enabled and runs entitlement integration tests.
2. Merge the Phase 2 branch.
3. Apply the database migration to the HookEngine Supabase project.
4. Deploy the updated `hookengine-generate` Edge Function.
5. Publish the account portal update.
6. Verify signup trial assignment, UTC credit grants, each plan cap, refunds, timeout cleanup, history retention and cost telemetry.

Do not deploy only one half of the migration/function contract: the Edge Function now calls the new RPC signatures.

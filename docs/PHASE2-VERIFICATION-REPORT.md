# HookEngine Phase 2 — evidence-based verification report

**Checked:** 2026-10-31 09:38 UTC  
**Production project:** `ppaknwuwiublxogclqdw`  
**Extension manifest:** `1.7.0` (unchanged)  
**Production Edge Functions:** `hookengine-generate` v19, `hookengine-admin-plan` v5, `hookengine-paypal-webhook` v10 — all ACTIVE  
**Phase 3:** not started  
**Checkout:** disabled

## Executive result

The Phase 2 database and code paths have substantially stronger evidence now. The PostgreSQL migration/entitlement suite, popup regression tests, admin authorization/audit tests, PayPal signature/plan-ID tests, TypeScript checks and full-history secret scan all pass on commit `c9b3ff48d2a14150e4af58105afd4db082163287`.

This is **not a complete end-to-end sign-off**: a fresh live generation through `hookengine-generate` and a real PayPal sandbox delivery have not been executed. The audit table has no live request rows because the normal-user rejection test uses a mocked Auth response. These limits are listed explicitly below.

## 1. RLS, table grants and routine privileges

### Table-level grants

The production query inspected every `public.hookengine_*` table using `pg_class.relrowsecurity` and `has_table_privilege`.

| Table | RLS | anon | authenticated | service_role |
|---|---:|---|---|---|
| `hookengine_admin_audit` | on | no access | no access | insert/update/delete |
| `hookengine_credit_ledger` | on | no access | no access | insert/update/delete |
| `hookengine_generations` | on | no access | SELECT only | insert/update/delete |
| `hookengine_internal_accounts` | on | no access | no access | insert/update/delete |
| `hookengine_model_rates` | on | no access | no access | insert/update/delete |
| `hookengine_paypal_webhook_events` | on | no access | no access | insert/update/delete |
| `hookengine_plans` | on | no access | SELECT only | insert/update/delete |
| `hookengine_profiles` | on | no access | SELECT only | insert/update/delete |
| `hookengine_subscriptions` | on | no access | SELECT only | insert/update/delete |

No browser role has INSERT, UPDATE or DELETE grants on any HookEngine table. The four authenticated SELECT grants are additionally constrained by RLS.

### Policies returned by `pg_policies`

| Table | Policy | Command | Predicate |
|---|---|---|---|
| `hookengine_generations` | Users can read their own generation history | SELECT | `auth.uid() = user_id AND hookengine_history_visible(created_at)` |
| `hookengine_plans` | Authenticated users can read active HookEngine plans | SELECT | `is_active` |
| `hookengine_profiles` | Users can read their HookEngine profile | SELECT | `auth.uid() = user_id` |
| `hookengine_subscriptions` | Users can read their own subscription | SELECT | `auth.uid() = user_id` |

The audit, ledger, internal-account, model-rate and PayPal-event tables intentionally have RLS enabled and no browser policies. Their browser grants are also revoked; this is deny-by-default, not public access.

### Routine execution privileges

The production query used `has_function_privilege` for `anon`, `authenticated` and `service_role`.

| Routine | anon | authenticated | service_role | Security |
|---|---:|---:|---:|---|
| `hookengine_admin_set_plan` | no | no | yes | DEFINER |
| `hookengine_apply_paypal_event` | no | no | yes | DEFINER |
| `hookengine_assign_lifetime` | no | no | yes | DEFINER |
| `hookengine_cleanup_reservations` | no | no | yes | DEFINER |
| `hookengine_expire_trials` | no | no | yes | DEFINER |
| `hookengine_finish_generation` | no | no | yes | DEFINER |
| `hookengine_get_usage` | no | yes | yes | INVOKER |
| `hookengine_history_visible` | no | yes | yes | INVOKER |
| `hookengine_my_usage` | no | yes | yes | INVOKER |
| `hookengine_on_user_created` | no | no | yes | DEFINER |
| `hookengine_refresh_credit_period` | no | no | yes | DEFINER |
| `hookengine_reserve_generation` | no | no | yes | DEFINER |
| `hookengine_source_retention_cleanup` | no | no | yes | DEFINER |

This directly verifies that anon/authenticated cannot execute reservation or finalization, cannot call the admin plan RPC, and cannot write subscriptions.

## 2. Admin plan endpoint

Production endpoint: `hookengine-admin-plan` v5 ACTIVE.

The handler:
1. Requires a Bearer token.
2. validates it by calling Supabase Auth `/auth/v1/user`.
3. Checks the returned, confirmed email against the configured admin allowlist.
4. Writes a service-role audit row for denied, attempted, failed and successful plan actions.
5. Refuses to change a plan if the audit write fails.
6. Does not permit Lifetime as a manual plan override.

CI test output on the PR head:
- `normal authenticated user is rejected and the rejection is audited` — **passed**. Mock Auth returned a confirmed normal user; handler returned 403, wrote `rejected_not_admin` / HTTP 403, and did not call the plan RPC.
- `invalid session is rejected and audited` — **passed**. Mock Auth returned 401; handler wrote `rejected_invalid_session`.

**Not a live-token test:** the tests use a mocked Auth response. The production `hookengine_admin_audit` table currently returns zero rows, so no real normal-user request has yet been sent to the deployed endpoint.

## 3. PayPal webhook

Production endpoint: `hookengine-paypal-webhook` v10 ACTIVE.

### Signature verification

The handler calls PayPal's `POST /v1/notifications/verify-webhook-signature` endpoint and submits:
- `paypal-auth-algo`
- `paypal-cert-url`
- `paypal-transmission-id`
- `paypal-transmission-sig`
- `paypal-transmission-time`
- the configured `PAYPAL_WEBHOOK_ID`
- the received `webhook_event`

The handler accepts an event only when PayPal's response is HTTP-successful and `verification_status === "SUCCESS"`. Missing transmission headers fail closed.

CI tests:
- forged/test signature with PayPal verification response `FAILURE` — rejected;
- valid signature with PayPal verification response `SUCCESS` — accepted;
- missing transmission headers — rejected without an API call.

These are deterministic mocked-verifier tests, not a real PayPal sandbox delivery.

### Idempotency

Table: `public.hookengine_paypal_webhook_events`.

Production schema:
- `event_id` is NOT NULL and is the primary key.
- Primary key index: `hookengine_paypal_webhook_events_pkey`, unique B-tree on `event_id`.
- Other stored fields: `event_type`, `subscription_id`, `event_time`, `outcome`, `processed_at`.

The database function also takes an advisory lock keyed by event ID and returns `duplicate_event` for a replay.

### Event tests

Rollback-only production SQL test results:

| Event | Result | Final plan/status |
|---|---|---|
| `BILLING.SUBSCRIPTION.CANCELLED` | `applied: true` | Free / cancelled |
| Same event ID replayed | `applied: false, reason: duplicate_event` | unchanged |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | `applied: true` | Free / past_due |
| `PAYMENT.SALE.REFUNDED` | `applied: true` | Free / past_due |

Refund/reversal policy: a refunded or reversed subscription sale revokes Pro entitlement. The refund/reversal migration is applied in production and included in the passing CI migration suite.

Plan ID tests pass for missing configuration, wrong ID and exact configured Pro plan ID. The live value of `PAYPAL_PRO_PLAN_ID` has not been independently confirmed. The webhook fails closed with HTTP 503 on activation if it is not configured. Checkout remains disabled.

## 4. Cron jobs and cleanup tests

Production `cron.job` rows:

| Job | Schedule | Latest recorded run |
|---|---|---|
| `hookengine-reservation-cleanup` | `* * * * *` | 2026-10-31 09:38 UTC — succeeded, returned 1 row |
| `hookengine-trial-expiry` | `5 * * * *` | 2026-10-31 09:05 UTC — succeeded, returned 1 row |
| `hookengine-source-retention` | `25 3 * * *` | no run recorded yet |

The source-retention job was installed after its 03:25 UTC slot on Oct 31, so its next scheduled run is the following day. It is active, but its first scheduled run has not been observed.

Rollback-only production tests:
- Stale reservation: cleanup returned 1; generation became `failed`; `refunded_at` was populated; one refund ledger row was written; balance returned from 40 to 40.
- Trial expiry: expiry returned 1; subscription became `free / inactive`, balance 0 and trial end NULL; profile plan became Free; one `trial-expire:<user_id>` ledger entry was written.

## 5. Usage RPC and allowance tests

### Definitions

- `credits_balance`: remaining credits in the current plan period.
- `credits_used`: current-period allowance consumed, calculated as `max(0, credits_total - credits_balance)`.
- `credits_consumed`: sum of `credits_reserved` across all completed generations for the account; it is historical, not just the current period.
- `total_generations`: count of completed generation rows.
- Failed generations are not included in `credits_consumed`; their reserved credits are refunded into the subscription balance and represented by a `refund` ledger entry plus `refunded_at` on the generation.

### Why 19 generations, 1 used and 2 consumed?

The live usage RPC returned 19 completed generations, `credits_used = 1`, `credits_consumed = 2`, `credits_balance = 299` of 300.

The generation rows show two completed generations with one reserved credit each:
- 2026-10-31 01:21 UTC: Trial-era row, Gemini provider, missing model and zero token counts.
- 2026-10-31 08:45 UTC: Pro-period row, Gemini `gemini-3.5-flash-lite`, 5,140 input tokens and 2,714 output tokens.

The other 17 completed rows have `credits_reserved = 0` because they predate the credit-reservation accounting. Thus the historical total is 2 credits, while the current Pro monthly pool has used 1 credit: 300 - 299 = 1.

The one fully metered generation has estimated cost `$0.008327`. The total token count is 7,854. The corrected `unpriced_generations` metric is 0 because it now counts positive-token rows with missing cost; this does **not** mean telemetry exists for all 19 historical generations. Most older rows have no provider/model/token data.

### Raw live account JSON

```json
{
  "plan": "pro",
  "period": "month",
  "reset_at": "2026-11-01T00:00:00+00:00",
  "platforms": [
    "x_thread",
    "linkedin_post",
    "tiktok_hooks",
    "instagram_caption",
    "threads_posts",
    "facebook_post"
  ],
  "daily_used": 4,
  "daily_limit": 30,
  "price_minor": null,
  "credits_used": 1,
  "history_days": null,
  "total_tokens": 7854,
  "window_start": "2026-10-01T00:00:00+00:00",
  "credits_total": 300,
  "trial_ends_at": null,
  "video_enabled": true,
  "voice_enabled": true,
  "voice_profile": true,
  "daily_reset_at": "2026-11-01T00:00:00+00:00",
  "history_cutoff": null,
  "lifetime_limit": 50,
  "price_currency": "EUR",
  "video_analysis": true,
  "credits_balance": 299,
  "remaining_daily": 26,
  "credits_consumed": 2,
  "lifetime_claimed": 0,
  "total_generations": 19,
  "average_latency_ms": 3174,
  "credits_per_period": 300,
  "total_input_tokens": 5140,
  "total_output_tokens": 2714,
  "unpriced_generations": 0,
  "versions_per_generation": 3,
  "estimated_provider_cost_usd": 0.008327,
  "regenerations_per_generation": null
}
```

### Synthetic Free account raw JSON

The following fixtures were created inside a transaction and rolled back. They are not persistent accounts.

After 1 generation:

```json
{"plan":"free","period":"week","reset_at":"2026-11-02T00:00:00+00:00","platforms":["x_thread","linkedin_post","tiktok_hooks"],"daily_used":1,"daily_limit":3,"price_minor":0,"credits_used":1,"history_days":7,"total_tokens":0,"window_start":"2026-10-26T00:00:00+00:00","credits_total":5,"trial_ends_at":null,"video_enabled":false,"voice_enabled":false,"voice_profile":false,"daily_reset_at":"2026-11-01T00:00:00+00:00","history_cutoff":"2026-10-24T09:30:17.486697+00:00","lifetime_limit":50,"price_currency":"EUR","video_analysis":false,"credits_balance":4,"remaining_daily":2,"credits_consumed":1,"lifetime_claimed":0,"total_generations":1,"average_latency_ms":0,"credits_per_period":5,"total_input_tokens":0,"total_output_tokens":0,"unpriced_generations":0,"versions_per_generation":1,"estimated_provider_cost_usd":0,"regenerations_per_generation":1}
```

After 3 generations:

```json
{"plan":"free","period":"week","reset_at":"2026-11-02T00:00:00+00:00","platforms":["x_thread","linkedin_post","tiktok_hooks"],"daily_used":3,"daily_limit":3,"price_minor":0,"credits_used":3,"history_days":7,"total_tokens":0,"window_start":"2026-10-26T00:00:00+00:00","credits_total":5,"trial_ends_at":null,"video_enabled":false,"voice_enabled":false,"voice_profile":false,"daily_reset_at":"2026-11-01T00:00:00+00:00","history_cutoff":"2026-10-24T09:30:17.486697+00:00","lifetime_limit":50,"price_currency":"EUR","video_analysis":false,"credits_balance":2,"remaining_daily":0,"credits_consumed":3,"lifetime_claimed":0,"total_generations":3,"average_latency_ms":0,"credits_per_period":5,"total_input_tokens":0,"total_output_tokens":0,"unpriced_generations":0,"versions_per_generation":1,"estimated_provider_cost_usd":0,"regenerations_per_generation":1}
```

After 5 generations (three fixture rows were moved to the previous UTC day so the independent daily cap would not block the weekly-pool test):

```json
{"plan":"free","period":"week","reset_at":"2026-11-02T00:00:00+00:00","platforms":["x_thread","linkedin_post","tiktok_hooks"],"daily_used":2,"daily_limit":3,"price_minor":0,"credits_used":5,"history_days":7,"total_tokens":0,"window_start":"2026-10-26T00:00:00+00:00","credits_total":5,"trial_ends_at":null,"video_enabled":false,"voice_enabled":false,"voice_profile":false,"daily_reset_at":"2026-11-01T00:00:00+00:00","history_cutoff":"2026-10-24T09:30:17.486697+00:00","lifetime_limit":50,"price_currency":"EUR","video_analysis":false,"credits_balance":0,"remaining_daily":1,"credits_consumed":5,"lifetime_claimed":0,"total_generations":5,"average_latency_ms":0,"credits_per_period":5,"total_input_tokens":0,"total_output_tokens":0,"unpriced_generations":0,"versions_per_generation":1,"estimated_provider_cost_usd":0,"regenerations_per_generation":1}
```

Exact limit responses:

```json
{"plan":"free","used":3,"reason":"daily_cap","allowed":false,"message":"Daily cap reached (3/3). Resets at 2026-11-01 00:00 UTC.","reset_at":"2026-11-01T00:00:00+00:00","daily_limit":3,"legacy_reason":"daily_limit_reached","credits_balance":2}
{"plan":"free","reason":"weekly_limit","allowed":false,"message":"Weekly pool exhausted. Resets at 2026-11-02 00:00 UTC.","reset_at":"2026-11-02T00:00:00+00:00","credits_balance":0,"credits_required":1}
```

### Synthetic Trial account raw JSON

These fixtures were also created and rolled back.

After 1 generation:

```json
{"plan":"trial","period":"trial","reset_at":"2026-11-05T09:30:17.486697+00:00","platforms":["x_thread","linkedin_post","tiktok_hooks","instagram_caption","threads_posts","facebook_post"],"daily_used":1,"daily_limit":30,"price_minor":0,"credits_used":1,"history_days":null,"total_tokens":0,"window_start":"2026-10-29T09:30:17.486697+00:00","credits_total":40,"trial_ends_at":"2026-11-05T09:30:17.486697+00:00","video_enabled":true,"voice_enabled":true,"voice_profile":true,"daily_reset_at":"2026-11-01T00:00:00+00:00","history_cutoff":null,"lifetime_limit":50,"price_currency":"EUR","video_analysis":true,"credits_balance":39,"remaining_daily":29,"credits_consumed":1,"lifetime_claimed":0,"total_generations":1,"average_latency_ms":0,"credits_per_period":40,"total_input_tokens":0,"total_output_tokens":0,"unpriced_generations":0,"versions_per_generation":3,"estimated_provider_cost_usd":0,"regenerations_per_generation":null}
```

After 3 generations:

```json
{"plan":"trial","period":"trial","reset_at":"2026-11-05T09:30:17.486697+00:00","platforms":["x_thread","linkedin_post","tiktok_hooks","instagram_caption","threads_posts","facebook_post"],"daily_used":3,"daily_limit":30,"price_minor":0,"credits_used":3,"history_days":null,"total_tokens":0,"window_start":"2026-10-29T09:30:17.486697+00:00","credits_total":40,"trial_ends_at":"2026-11-05T09:30:17.486697+00:00","video_enabled":true,"voice_enabled":true,"voice_profile":true,"daily_reset_at":"2026-11-01T00:00:00+00:00","history_cutoff":null,"lifetime_limit":50,"price_currency":"EUR","video_analysis":true,"credits_balance":37,"remaining_daily":27,"credits_consumed":3,"lifetime_claimed":0,"total_generations":3,"average_latency_ms":0,"credits_per_period":40,"total_input_tokens":0,"total_output_tokens":0,"unpriced_generations":0,"versions_per_generation":3,"estimated_provider_cost_usd":0,"regenerations_per_generation":null}
```

## 6. Video reservation refund

A rollback-only production SQL test reserved five credits for a first YouTube video analysis, finalized it as failed, and observed:
- `status = failed`
- `credits_reserved = 5`
- `refunded_at` populated
- one `refund` ledger row
- balance restored from 299 to 299

The PostgreSQL CI suite also tests this behavior. This is a database reservation/finalization test, **not** a live provider failure through the Edge Function.

## 7. Lifetime inventory correction

The owner/admin account had incorrectly claimed a Lifetime spot during a previous manual plan sequence. The historical credit ledger confirms a Lifetime initial grant and later conversion, but there was no audit row at the time, so the exact initiating HTTP request cannot be attributed.

Production correction:
- admin subscription remains Pro;
- `lifetime_claimed_at` is NULL;
- current Lifetime claimed count is 0;
- `hookengine_assign_lifetime(admin_user)` returns `{"assigned":false,"reason":"internal_account"}`;
- internal-account registry and allocator guard are active.

## 8. Popup usage display

The new popup display reads all values from `hookengine_my_usage()`; the copy itself is unit-tested.

- Free: `2 of 5 sources left this week · resets Monday`.
- Trial: `Pro trial: 31 of 40 credits left · 5 days left`.
- Pro/Lifetime: remaining credits and the billing-period reset date.
- Daily line is hidden with more than one daily use remaining; it warns at one remaining and names the exhausted cap when reached, e.g. `Daily limit reached (3/3) · resets at 00:00 UTC`.
- A plan tag (Free / Trial / Pro / Lifetime) is shown beside the main usage line.
- Fixed the existing missing `planSummary` DOM element, which would otherwise cause `renderAccount()` to fail.
- Extension version was not changed.

## 9. CI evidence

On commit `c9b3ff48d2a14150e4af58105afd4db082163287`:
- Phase 2 validation: **success** — PostgreSQL migrations/entitlement tests, Deno type checks, admin endpoint tests, PayPal plan-ID and signature tests.
- Extension tests: **success** — JavaScript syntax and Node regression tests, including usage display.
- Full-history secret scan: **success**.

Workflow run links:
- [Phase 2 validation](https://github.com/yazoniplay/HookEngine/actions/runs/41189399585)
- [Extension tests](https://github.com/yazoniplay/HookEngine/actions/runs/41189399565)
- [Full-history secret scan](https://github.com/yazoniplay/HookEngine/actions/runs/41189399587)

## 10. Remaining external verification

These are still open and are not represented as passed:

1. **Live generation:** no fresh authenticated request has been sent through production `hookengine-generate`. Provider, tokens and balance before/after remain unverified live.
2. **Gemini fallback:** no live forced Gemini failure has been induced against the deployed Edge Function. Provider fallback code is type-checked, but live fallback remains unverified.
3. **Video provider failure:** the five-credit refund is verified at the database RPC level; the real video provider failure path is not.
4. **Admin production request:** normal-user denial and audit behavior passed against mocked Supabase Auth in CI. A live normal-user JWT request and production audit row are still missing; the production audit table is currently empty.
5. **PayPal sandbox:** signature/plan-ID behavior passed mocked tests and database event transitions passed rollback-only SQL tests. No real PayPal sandbox event delivery or forged HTTP request was made. The configured `PAYPAL_PRO_PLAN_ID` has not been independently checked.
6. **Source retention cron:** active, but no run recorded yet; its first scheduled slot is upcoming.
7. **Supabase Auth setting:** security advisor still reports leaked-password protection disabled. Enable it in Supabase Dashboard → Authentication → Password Security.

Checkout remains disabled until the real billing configuration and sandbox cycle are verified. Phase 3 has not started.

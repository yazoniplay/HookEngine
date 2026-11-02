# Phase 0.3 — Privacy and Terms Evidence Report

**Status:** Implemented on the review branch. Customer-facing data-handling claims below are tied to the current code or database migrations. Line references refer to this commit.

## Claims and implementation evidence

| Customer-facing claim | Evidence |
|---|---|
| Account sign-up and password sign-in are handled through Supabase Auth endpoints. | `account/account.js:95-114` |
| HookEngine's reservation computes a SHA-256 digest and character length for submitted source text. | `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:109-134` |
| The reservation insert writes `NULL` to `source_text` and persists the digest and length instead. | `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:232-240` |
| The migration clears legacy non-null source-text values. | `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:26-47` |
| The scheduled cleanup clears legacy `source_text`; it does not expire generated output fields. | `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:588-614` |
| Generation records include source title, URL, type and timestamps, plus generated output, provider/model, token, timing, credit, cost and error metadata. | `supabase/migrations/20261024155344_hookengine_usage_limits_history.sql:8-22`; `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:26-39, 340-365` |
| Generated drafts are stored in the generation record's `outputs` JSONB field when a generation completes. | `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:340-365`; `supabase/functions/hookengine-generate/index.ts:104-124, 418-430` |
| Free history has a seven-day visibility window; Pro and Lifetime have `NULL` history cutoffs. | `supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql:84-100` |
| Database history visibility treats a null cutoff as no age-based filter. | `supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql:313-345`; `supabase/migrations/20261031120000_hookengine_phase2_spec_alignment.sql:507-529` |
| Generation records are linked to the authentication user with `ON DELETE CASCADE`. | `supabase/migrations/20261024155344_hookengine_usage_limits_history.sql:8-22` |
| Generation-history access is owner-scoped by row-level security. | `supabase/migrations/20261024155344_hookengine_usage_limits_history.sql:35-45`; `supabase/migrations/20261031004500_hookengine_plan_credits_entitlements.sql:341-345` |
| Gemini is the primary text provider; configured Groq and Ollama fallbacks are in the text-generation fallback chain. | `supabase/functions/hookengine-generate/index.ts:17-22, 155-186, 197-250` |
| YouTube video analysis is sent to Google's Gemini API. | `supabase/functions/hookengine-generate/index.ts:256-329` |
| Submitted source text is included in the text-generation prompt. | `supabase/functions/hookengine-generate/index.ts:140-151, 240-250` |
| The account portal queries the signed-in user's generation history and has no self-service delete control. | `account/account.js:140-151, 204-222`; `account/index.html:1-92` |
| Pro checkout is disabled in the account portal. | `account/account.js:190-194` |

## Production verification note

The project owner reports that a production check found **zero rows with non-NULL `source_text`** at the time of that check. This was supplied as owner-provided verification; it was not independently queried during this code change. The migration and reservation-function evidence above is independently visible in the repository.

## Retention wording

- Free: the database enforces the configured history visibility window. Older Free-plan generation records remain stored in the database but are hidden from the Free history view; the visibility cutoff does not delete those rows.
- Pro and Lifetime: the plan seed has `history_days = NULL`, and the policy treats a null cutoff as no age-based history filter. No paid generated-draft expiry period is claimed.
- The extension stores its sign-in session, latest generation result and theme in `chrome.storage.local`; writing preferences (tone, style, length and audience) use `chrome.storage.sync`.
- The source-text cleanup job clears legacy raw source text only. It is not a generated-draft retention job.
- The account portal currently exposes no self-service delete control. Generation rows are linked to the authentication account and cascade when that account is deleted.

## Contact and legal status

- The only support address definition is `SUPPORT_EMAIL` in `support.js`, intentionally empty and marked `TODO(owner)`. Empty configuration hides support links, the contact FAQ item and contact sections without showing placeholder text. The Phase 6 release workflow blocks publication while the value is empty; no address was invented.
- `account/terms.html` is explicitly labeled a draft requiring qualified legal review before publication or use as binding terms.
- The terms draft's statement that checkout is disabled is supported by the disabled account upgrade control (`account/account.js:190-194`).

## Test evidence

The five Phase 0.2 mutation cases are covered: SQL seed drift (`5→6`), a hardcoded `3 variations in Pro` claim, stale `5 generations per day` copy, removal of the account's startup pricing render, and reintroduction of array-position-based assertions. Phase 0.3 also proves that a false no-draft-storage claim and an invented 90-day paid-history expiry are rejected.

A Node test extracts the latest reservation function body from the migration and proves that changing its insert from `NULL` to `v_source_text` is rejected. The banned-claims test checks all requested terms and the `deleted after N days` pattern. The Phase 6 workflow blocks a release while the support address is empty.

GitHub Actions is the test execution environment; tests are not claimed as locally run.

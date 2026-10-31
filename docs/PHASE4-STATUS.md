# HookEngine Phase 4 — User-facing plans and upgrade experience

**Status:** Implementation on `phase4-usage-upgrade-experience`; not merged or deployed.  
**Manifest:** 1.7.0 unchanged.  
**Database migrations:** None.  
**Checkout:** Remains disabled; upgrade links open the account portal only.

## Implemented on this branch

### Usage and trial visibility
- The extension now maps the complete `hookengine_my_usage()` response needed by the UI: current/total credits, plan period reset, daily usage/reset, trial expiry, plan entitlements and completed-generation count.
- The popup account strip uses the shared usage formatter. Free users see remaining weekly sources and the actual UTC reset weekday; Trial users see remaining trial credits and days; Pro/Lifetime users see their monthly balance and reset date.
- Daily usage shows the remaining daily generations and warns when one remains or the cap has been reached.

### Non-modal upgrade moments
- A one-time prompt appears after an account's first successful Free generation in the extension.
- Free users can click locked Version 2 and Version 3 tabs to see the Pro explanation; no fake draft content is shown.
- Pro-only platform selection is interactive but safely reverted for Free accounts, with an inline explanation.
- Missing YouTube transcripts and server-declared Pro-only video-analysis denials show an inline Pro prompt. Free users are still told they can use a manually selected transcript.
- Weekly/monthly credit exhaustion, daily caps, trial expiry and regeneration-limit errors show reset/upgrade context.
- Prompts are inline and dismissible; no modal blocks the workflow.

### Regeneration
- The Edge Function response now includes the reservation's generation ID.
- The background worker retains the original generation ID as the regeneration parent, without storing raw source text.
- The popup can regenerate from the source still present in the popup, or from the original YouTube URL; it preserves the original platform selection.
- The database remains authoritative: Free regeneration limits and Pro credit/usage limits are still enforced server-side.

### History
- The account portal now loads history in pages of 100, with a Load more history control.
- Existing RLS policy still enforces plan retention: Free history remains limited to its configured window; Pro/Trial/Lifetime history can be paged through without a fixed UI cap.

## Explicitly not implemented

### Voice preview and active voice profile
The database currently exposes only a boolean `voice_enabled` plan entitlement. A read-only schema inspection found no voice-profile table or voice-related profile columns, and the repository has no voice-profile storage, preview generation, or active-profile selection flow. Phase 4 does not pretend this entitlement is already a working feature. A real implementation needs a defined profile model and preview behavior before UI claims can be made.

## Validation and remaining acceptance tests

- The existing CI workflow checks Edge Function types, generation contract tests, CORS response tests, account JavaScript syntax, popup JavaScript syntax, background worker syntax and PostgreSQL migrations.
- No production database changes or Edge Function deployment have been made from this branch.
- Not yet verified in a real Chrome popup: usage display for Free/Trial/Pro, locked tabs, platform upsells, transcript-missing prompt, reset messaging, regeneration success/refusal, and multi-page history.
- No real Pro account was used to verify three returned versions or unlimited history paging.
- Checkout remains unavailable, so upgrade CTAs cannot complete a purchase.

## Manual acceptance checklist

1. Sign in as Free; confirm weekly credits and Monday UTC reset are accurate.
2. Confirm the daily remaining count and warning at one remaining generation.
3. Generate the account's first Free draft; confirm the inline prompt appears once.
4. Click Version 2/3 and each Pro-only platform; confirm the inline prompt appears and no locked platform is sent.
5. Test a public YouTube video without a transcript on Free; confirm the Pro prompt and transcript workaround.
6. Reach a daily/weekly limit in a controlled test account; confirm the exact reset message.
7. Generate on Pro/Trial; confirm three real versions and regenerate from the same source/platform selection.
8. In the account portal, page through more than 100 history rows on Pro and confirm older rows load; confirm Free retention remains restricted.
9. Verify that the manifest remains 1.7.0 and checkout remains disabled.

Do not merge or deploy this branch until the acceptance tests and the voice-profile scope are resolved.

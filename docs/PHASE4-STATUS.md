# HookEngine Phase 4 — User-facing plans and upgrade experience

**Status:** Implementation on `phase4-usage-upgrade-experience`; not merged or deployed.  
**Manifest:** 1.7.0 unchanged.  
**Database migrations:** None.  
**Checkout:** Remains disabled; upgrade links open the account portal only.

## Implemented on this branch

### Usage and trial visibility
- The extension now maps the complete `hookengine_my_usage()` response needed by the UI: current/total credits, plan period reset, daily usage/reset, trial expiry, plan entitlements and completed-generation count.
- The popup shows a dedicated credit meter with used/total credits and progress. Free users see weekly credits and the actual UTC reset weekday; Trial users see remaining trial credits and days; Pro/Lifetime users see monthly balance and reset date.
- A separate daily-generation meter shows remaining daily generations and the UTC reset warning.
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

## Active writing voice profile
- The existing Tone, Writing style, Length and Target audience preferences are the active writing profile. They are saved in Chrome sync storage and included in every generation request.
- Phase 4 adds a live profile summary in Settings, updating as the user changes those preferences. The preview is explicitly a settings preview, not a generated sample.
- There is no separate named-profile library or audio/voice-cloning feature. The database `voice_enabled` flag is not used to unlock the current writing preferences; it remains reserved until a separately specified advanced voice feature exists.

## Validation and remaining acceptance tests

- The existing CI workflow checks Edge Function types, generation contract tests, CORS response tests, account JavaScript syntax, popup JavaScript syntax, background worker syntax and PostgreSQL migrations.
- No production database changes or Edge Function deployment have been made from this branch.
- Not yet verified in a real Chrome popup: credit meter and daily usage for Free/Trial/Pro, locked tabs, platform upsells, transcript-missing prompt, reset messaging, regeneration success/refusal, and multi-page history.
- The Settings profile summary has automated syntax validation but still needs a visual check in Chrome.
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
9. Change tone/style/length/audience in Settings; confirm the active writing profile preview updates, then save and confirm the settings are applied to the next generation.
10. Verify that the manifest remains 1.7.0 and checkout remains disabled.

Do not merge or deploy this branch until the manual Chrome acceptance tests are completed.

# HookEngine Phase 3 — Edge Function reliability

**Status:** Implementation in review on `phase3-edge-reliability`. Not merged or deployed.  
**Scope:** Edge Function reliability, validation and output quality.  
**Manifest:** 1.7.0 unchanged.  
**Database migrations:** None added in this phase so far.  
**Checkout:** Remains disabled.

## Changes in this branch

### Request validation and plan enforcement
- Added a strict generation request contract.
- Rejects non-object JSON, invalid types, unsupported source modes, malformed URLs, oversized titles/source text, unknown or duplicate platform keys, invalid preference fields/values, invalid action types and malformed regeneration parent IDs.
- Enforces a 512 KiB request-body ceiling.
- Plan/feature entitlement remains authoritative in `hookengine_reserve_generation`; the Edge Function additionally validates the returned plan, platform list, variation count, generation UUID and reserved credit cost before calling a provider.
- Text generation costs one credit, first full-video analysis costs five, and regeneration costs one; the database remains the source of truth.

### Provider reliability and output contract
- Gemini text requests now send the API key in `x-goog-api-key`, not in the URL query string.
- Added a consistent system instruction for Gemini, Groq and Ollama.
- Gemini text requests retain structured JSON output and the 6,000-token output ceiling.
- Provider fallback is deterministic: network/timeouts, provider auth/rate/server errors and malformed model output may fall back to configured Groq then Ollama. A Gemini HTTP 400 is treated as a non-retryable request error.
- Video analysis remains Gemini-only; Groq/Ollama do not accept the same YouTube video input contract. The Interactions API receives standard lower-case JSON Schema types with an exact array length for variations; GenerateContent keeps its provider-specific schema casing.
- Draft variations are now requested as arrays when a plan allows multiple versions. Legacy separator-delimited strings are still accepted, and the database's legacy text columns receive serialized values.
- Account history now renders array-based variations correctly.

### CORS and error handling
- All JSON responses, including auth, validation, reservation, provider and unexpected errors, use the same CORS/no-store response helper.
- OPTIONS preflight is handled before authentication.
- Reservation RPC errors are caught and returned as a CORS-safe 503 rather than escaping as an unhandled function error.
- Request errors and provider errors return stable public messages; internal details are logged without API keys or response bodies.

**CORS restriction note:** The endpoint retains `Access-Control-Allow-Origin: *` because the browser extension does not have a stable, confirmed origin allowlist in this repository. CORS is not authentication: every generation still requires a valid Supabase user access token, and plan/credit decisions are enforced server-side. Credentials are not enabled. Once the published extension ID and any production web-app origins are fixed, replace the wildcard with an explicit allowlist and test each client origin.

### Video input and telemetry
- Gemini Interactions API requests now include `system_instruction`, `generation_config.max_output_tokens`, `store: false`, and the documented `x-goog-api-key` header.
- Text prompt is placed after the video input as recommended by Google's current video guide.
- Agentic video processing is selected for model IDs known to support it (Gemini 3.5 Flash Lite and documented 3.6–3.8 Flash families); other configured models retain static processing.
- Video token telemetry now reads Interactions API `usage.total_input_tokens` and `usage.total_output_tokens`.
- Text telemetry reads Gemini `usageMetadata`, Groq `usage`, or Ollama evaluation counts. Completed generation latency is measured around the provider call and passed to the existing finalization RPC.
- No hardcoded per-video duration cap was introduced. Google's current documentation describes model/context-dependent limits (up to 3 hours at low media resolution or 1 hour at high resolution for 1M-context models), and an 8-hour/day YouTube input allowance on the free API tier. Agentic processing is recommended for long-form input on supported models. This function is still synchronous with a 55-second provider timeout; very long or slow videos may time out and be refunded. Reliable long-running background polling remains a follow-up rather than being falsely represented as completed.

### Source privacy
- No database schema change was necessary: the existing reservation RPC computes a SHA-256 source fingerprint and source length, and inserts NULL into `source_text`.
- Existing PostgreSQL tests assert raw source text is not stored and that the hash matches the source.
- A production read-only check returned 23 generation rows, 23 SHA-256 hashes and zero non-NULL raw source-text rows.

## Tests

The branch adds:
- `tests/generation-contract.test.ts`: strict payload validation, YouTube URL validation, regeneration UUID validation, array/legacy output parsing, schema generation and provider fallback behavior.
- `tests/generation-http-response.test.ts`: CORS headers on JSON errors and preflight responses.
- CI checks generation Edge Function types, both new test files, existing reservation tests, admin/PayPal checks, extension JavaScript syntax and PostgreSQL migrations.

The production source-privacy check was read-only. No production Edge Function has been replaced in this phase yet.

## Not yet verified

- No live Gemini, Groq or Ollama generation has been called through the revised code.
- No live forced provider fallback has been executed.
- No live YouTube video was submitted; the new Interactions API token parsing and agentic selection are code/documentation verified, not provider verified.
- The 55-second synchronous timeout remains a constraint for long videos.
- The wildcard CORS origin remains until the production extension/web origins are confirmed.
- No Phase 4 work has started.

## Manual steps after merge/deploy
1. Load the updated extension from the repository in desktop Chrome (the Android Chrome app cannot load unpacked extensions).
2. Test one Free text generation, one Pro/Trial multi-variation generation, a rejected Pro-only platform on Free, and a regeneration.
3. Verify provider, token counts, latency and credit balance in account history/usage.
4. If testing YouTube video analysis, use a public video and check the reservation/refund result if the provider times out.

Do not change the extension manifest version, enable checkout, or start Phase 4 as part of this phase.

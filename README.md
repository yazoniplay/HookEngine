# HookEngine

Chrome Manifest V3 extension popup that opens from the browser toolbar and turns articles, selected page text and public YouTube videos into editable social drafts.

## Plans
- Free includes X threads, LinkedIn posts and TikTok hooks.
- Pro adds Instagram captions, Threads sequences and Facebook posts, plus additional variations.
- Limits and credit costs are listed under [Account, credits and billing](#account-credits-and-billing). The database is the source of truth; the account portal shows each signed-in user's live balance.

## Managed AI providers
All provider calls run inside the Supabase Edge Function. Provider keys are never included in extension code.

Required Edge Function secrets:
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional; defaults to `gemini-3.5-flash-lite`)

Optional text-generation fallback secrets:
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional; defaults to `llama-3.3-70b-versatile`)
- `OLLAMA_API_KEY` (Ollama Cloud API key)
- `OLLAMA_MODEL` (optional; defaults to `gpt-oss:20b`)

Text generation order: Gemini, then Groq, then Ollama Cloud. Fallback is attempted for transient provider/network failures, not invalid requests or quota errors. Public YouTube video analysis uses Gemini only because the fallback providers are configured for text input. Fallback providers require working credentials and available capacity; they are not guaranteed to be free or unlimited.

### CORS
The `hookengine-generate` and `hookengine-admin-plan` functions use an origin allowlist, never a wildcard. A request from an origin that is not listed receives no `Access-Control-Allow-Origin` header.

- `hookengine-generate`: set the optional `HOOKENGINE_ALLOWED_ORIGINS` secret to a comma-separated list (for example `https://yazoniplay.github.io,chrome-extension://<published-extension-id>`). It defaults to `https://yazoniplay.github.io`. The extension itself does not need to be listed because its `host_permissions` bypass CORS.
- `hookengine-admin-plan`: allows only the account portal origin.

## Supabase database
SQL files in `supabase/migrations` are applied in filename order. Apply any new migration before deploying an Edge Function that depends on it. `tests/run-postgres-migration-tests.sh` applies all of them to a throwaway PostgreSQL container and runs the entitlement tests.

## Extension popup

The extension version is set in `manifest.json`.
HookEngine opens as a toolbar popup, not a Chrome side panel.

1. Open `chrome://extensions`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select this repository folder.
4. Sign in, read a page or paste source text, choose platforms and generate.

## Chrome Web Store package
```bash
bash scripts/package-extension.sh
```
This writes `dist/hookengine-chrome-web-store.zip` containing only the runtime files (no docs, SQL, tests or portal) and fails if a required file is missing. CI builds the same package and uploads it as an artifact.

## Development checks
Extension regression suite (Node.js 22 or newer):

```bash
node --test tests/*.test.mjs
```

Edge Function checks (Deno 2):

```bash
deno check supabase/functions/hookengine-generate/index.ts
deno test tests/generation-contract.test.ts tests/generation-http-response.test.ts tests/reservation-status.test.ts
deno test supabase/functions/hookengine-admin-plan/handler.test.ts
```

## Account, credits and billing
- Account portal: https://yazoniplay.github.io/HookEngine/account/
- The extension reads the signed-in account's authoritative credit balance and daily limit from Supabase.
- Free: 5 credits per UTC week and 3 generations per UTC day.
- Trial: 40 credits for 7 days, with Pro features.
- Pro: 300 credits per UTC month and 30 generations per UTC day.
- Lifetime: 150 credits per UTC month and Pro features; 50 Lifetime allocations total.
- Article/text generation and regeneration reserve 1 credit; YouTube video analysis and regeneration reserve 5 credits.
- Failed generations refund their reserved credits. Successful generations record token usage, latency and estimated provider cost where model pricing is configured.
- PayPal checkout is currently disabled in the account portal. Enabling it depends on the merchant credentials and a configured PayPal billing plan; see `docs/PAYPAL-SANDBOX-SETUP.md`.

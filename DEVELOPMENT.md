# Development

Notes for people building or deploying HookEngine. The product description is in the [README](README.md).

## Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** and choose **Load unpacked**.
3. Select this repository folder.

## Edge Function secrets

The generation API is the Supabase Edge Function `hookengine-generate`. Provider keys live only in the function's secrets, never in the extension.

Required:
- `GEMINI_API_KEY`
- `ANON_IP_SALT`: a long random string used to hash connection addresses for the daily limit. Keep it secret and do not rotate it casually, since rotating it resets everyone's daily count.

Optional:
- `GEMINI_MODEL` (default `gemini-3.5-flash-lite`)
- `GROQ_API_KEY`, `GROQ_MODEL` (default `llama-3.3-70b-versatile`)
- `OLLAMA_API_KEY`, `OLLAMA_MODEL` (default `gpt-oss:20b`)
- `OPENROUTER_API_KEY`, `OPENROUTER_VIDEO_MODEL`
- `GLOBAL_DAILY_CREDIT_CAP` (default `100`): the shared daily credit limit for anonymous use.
- `HOOKENGINE_ALLOWED_ORIGINS`: comma-separated browser origins allowed to read responses. Defaults to `https://yazoniplay.github.io`.

Text generation order: Gemini, then Groq, then Ollama Cloud. Fallback runs for transient provider or network failures, not for invalid requests or quota errors. YouTube analysis tries Gemini first, then OpenRouter, Groq and Ollama, using sampled frames where needed.

### Anonymous limits

Anonymous requests send no Authorization header. The function charges 1 credit for an article or text draft and 5 for a YouTube video, up to 10 credits per hashed connection per UTC day and the global cap per day. Limits are enforced in the database by `hookengine_reserve_anonymous`. The function must be deployed with JWT verification off so anonymous requests reach it:

```bash
supabase functions deploy hookengine-generate --no-verify-jwt
```

A request with an invalid Authorization token returns 401. A request with no token goes anonymous.

## Database

SQL files in `supabase/migrations` apply in filename order. Apply any new migration before deploying a function that depends on it.

`tests/run-postgres-migration-tests.sh` applies all migrations to a throwaway PostgreSQL container and runs the entitlement tests.

## Checks

Extension tests (Node.js 22 or newer):

```bash
node --test tests/*.mjs
```

Edge Function checks (Deno 2):

```bash
deno check supabase/functions/hookengine-generate/index.ts
deno test tests/generation-contract.test.ts tests/generation-http-response.test.ts tests/reservation-status.test.ts
```

## Chrome Web Store package

```bash
bash scripts/package-extension.sh
```

This writes `dist/hookengine-chrome-web-store.zip` with only the runtime files. It fails if a required file is missing. CI builds the same package and uploads it as an artifact.

## Store and site

- Landing page: https://yazoniplay.github.io/HookEngine/
- Privacy policy: https://yazoniplay.github.io/HookEngine/account/privacy.html

# HookEngine

Chrome Manifest V3 extension popup that opens from the browser toolbar and turns articles, selected page text and public YouTube videos into editable social drafts.

## Plans
- Free includes X threads, LinkedIn posts and TikTok hooks.
- Pro adds Instagram captions, Threads sequences and Facebook posts, plus additional variations.
- Current usage limits are shown in the account portal; this README intentionally avoids hard-coding limits that may change.

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

## Supabase database
Apply the new migration under `supabase/migrations` before deploying the updated Edge Function. It adds JSON output, selected-platform metadata and provider attribution to generation history, and updates the server-only finalize RPC.

## Extension popup

Current extension manifest version: `1.8.0`.
HookEngine opens as a toolbar popup, not a Chrome side panel.

1. Open `chrome://extensions`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select this repository folder.
4. Sign in, read a page or paste source text, choose platforms and generate.

## Development checks
Run the extension regression suite with Node.js 22 or newer:

```bash
node --test tests/*.test.mjs
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
- PayPal checkout still depends on the existing merchant credentials and configured PayPal billing plan.

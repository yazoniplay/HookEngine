# YouTube video provider fallbacks

HookEngine tries video providers in this order:

1. Gemini: native YouTube video input through the Gemini Interactions API.
2. OpenRouter: native `video_url` input. The configured model must support video input.
3. Groq: a vision model receives up to three signed YouTube storyboard contact sheets plus the transcript.
4. Ollama Cloud: a vision model receives the same sampled storyboard images as base64 plus the transcript.

## Edge Function secrets

| Secret | Required for | Default model |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini primary | `gemini-3.5-flash-lite` |
| `OPENROUTER_API_KEY` | OpenRouter native video fallback | `qwen/qwen3.6-flash` |
| `GROQ_API_KEY` | Groq storyboard-image fallback | `qwen/qwen3.6-27b` |
| `OLLAMA_API_KEY` | Ollama Cloud storyboard-image fallback | `gemma4` |

Optional model overrides: `OPENROUTER_VIDEO_MODEL`, `GROQ_VIDEO_MODEL`, and `OLLAMA_VIDEO_MODEL`.

Set these as Supabase Edge Function secrets for `hookengine-generate`. Existing Groq and Ollama text-generation settings remain separate.

## Important limitations

- OpenRouter's selected model and upstream provider must support video input. A model accepting images is not sufficient for native video input.
- Groq's documented vision API accepts images, not a raw YouTube video stream. HookEngine therefore sends signed YouTube storyboard sheets: sampled still-frame contact sheets, not full-motion footage.
- Ollama's chat API accepts image inputs, not a raw video stream. HookEngine sends the same sampled storyboard sheets as image data.
- The transcript is used for speech and sequence context. Storyboards supply sampled visual context; they do not preserve motion, every frame, or audio.
- Some videos do not expose storyboard metadata (for example, some short clips, restricted videos, or livestreams). In that case, Groq and Ollama cannot be used for visual fallback on that video; OpenRouter may still work.
- A provider fallback is recorded using the provider and model that actually generated the result. Failed or unsupported providers are skipped rather than described as having analysed the video.

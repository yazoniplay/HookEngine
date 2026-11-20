import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  GENERATION_SYSTEM_INSTRUCTION,
  interactionsSchemaFor,
  parseOutputs,
  parseVideoOutputs,
  videoDraftQualityIssues,
  runWithProviderFallback,
  draftPolicyIssues,
  schemaFor,
  serializeOutput,
  validateGenerationPayload,
  validYouTube,
  parseYouTubeStoryboardSpec,
  type YouTubeStoryboardSheet,
  type GenerationPayload,
  type GenerationPreferences,
} from "./generation-contract.ts";
import { reservationHttpStatus, reservationLimitReached } from "./reservation-status.ts";
import { buildCorsHeaders, corsPreflight, jsonReply, parseAllowedOrigins } from "./http-response.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-3.1-flash-lite";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile";
const GROQ_VIDEO_MODEL = Deno.env.get("GROQ_VIDEO_MODEL") || "qwen/qwen3.6-27b";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const OPENROUTER_VIDEO_MODEL = Deno.env.get("OPENROUTER_VIDEO_MODEL") || "qwen/qwen3.6-flash";
const OPENROUTER_TEXT_MODEL = Deno.env.get("OPENROUTER_TEXT_MODEL") || "qwen/qwen3.6-flash";
const OLLAMA_API_KEY = Deno.env.get("OLLAMA_API_KEY") || "";
const OLLAMA_MODEL = Deno.env.get("OLLAMA_MODEL") || "gpt-oss:20b";
const OLLAMA_VIDEO_MODEL = Deno.env.get("OLLAMA_VIDEO_MODEL") || "gemma4";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAX_REQUEST_BYTES = 512 * 1024;

// Anonymous (no login) usage. Caps are counted in credits, the same units as accounts:
// 1 credit per article or text draft, 5 per YouTube video. Limits are enforced in the
// database; this module only hashes the client IP with a server-side salt and never
// stores or logs the raw address.
const ANONYMOUS_IP_DAILY_CREDITS = 10;
const ANONYMOUS_PLATFORMS = ["x_thread", "linkedin_post", "tiktok_hooks"];
const ANON_IP_SALT = Deno.env.get("ANON_IP_SALT") || "";
const GLOBAL_DAILY_CREDIT_CAP = (() => {
  const parsed = Number(Deno.env.get("GLOBAL_DAILY_CREDIT_CAP"));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
})();

// Comma-separated browser origins allowed to read responses (e.g. the account portal and, optionally,
// chrome-extension://<published-extension-id>). The extension works without being listed because its
// host_permissions bypass CORS. Defaults to the account portal origin.
const ALLOWED_ORIGINS = parseAllowedOrigins(Deno.env.get("HOOKENGINE_ALLOWED_ORIGINS"));

const PLATFORM_GUIDANCE: Record<string, string> = {
  x_thread: "Write a thread of 3–6 posts, fewer when the source is short. Never pad to reach a count. Put each post on its own line, separated by a blank line, numbered like 1/, 2/. Post 1 is the hook: open with the single most specific claim, number, tension or question from the source, never a description of the subject or a label like 'Here is a thread'. Each later post adds one new detail or step from the source (about 180–260 characters). Do not repeat a point across posts. Vary sentence shape and end with a clear takeaway, not a generic call to action. No hashtags, no emoji, no empty one-line posts.",
  linkedin_post: "Write a 180–260 word LinkedIn post. The first line is one specific observation that makes a reader stop, not a question into the void and not 'I am excited to share'. Explain the central idea with a concrete example or detail from the source, in short paragraphs. End with one sentence of insight the reader can use. No hashtags unless the source names a specific topic, and no engagement bait such as 'Agree?'.",
  tiktok_hooks: "Write five spoken hooks, each on its own line and numbered 1. to 5., 12–25 words each. Use a different pattern for each: curiosity gap, bold claim, specific number, contrarian take, direct question. Use only facts and wording from the source: no invented adjectives, places, superlatives or claims beyond the source, and no labels such as 'Curiosity gap:' in the output. Use a number only if the source contains that number. Then write a 30–45 second spoken script (80–120 words) based on the strongest hook: short sentences, contractions, one concrete example from the source, and a closing line that sounds like speech. No headings, stage directions or lists in the script.",
  instagram_caption: "Write a developed Instagram caption of roughly 120–200 words when the source supports it. Start with a strong specific first line, tell the idea as a compact story or explanation, include useful detail and preserve the speaker's natural voice. Use readable line breaks; add only a few relevant hashtags when genuinely useful. Do not invent calls to action.",
  threads_posts: "Write 3–5 substantive, conversational Threads posts, usually 35–65 words each. Each post should stand alone while advancing one coherent sequence. Include the actual insight or example rather than teaser fragments.",
  facebook_post: "Write a complete Facebook post of roughly 140–220 words when the source supports it. Give enough context for someone who has not watched the video, explain the key point with a concrete detail, and close naturally. Avoid filler, engagement bait and invented calls to action.",
};

type TextGenerationResult = {
  outputs: Record<string, string[]>;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

function safeErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 503;
}

type VideoStoryboardContext = {
  sheets: YouTubeStoryboardSheet[];
  ollamaImages: string[];
};

function extractJsonObject(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function summarizeGeminiVideoOutput(raw: string, platforms: string[]) {
  let value = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}\s*$/, "");
  const tryParse = (candidate: string): unknown => {
    try {
      let parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = tryParse(value.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { jsonParsed: false, firstCharacter: value[0] ?? null, hasOpeningBrace: value.includes("{"), hasClosingBrace: value.includes("}") };
  }
  const record = parsed as Record<string, unknown>;
  const nested = record.outputs && typeof record.outputs === "object" && !Array.isArray(record.outputs)
    ? record.outputs as Record<string, unknown>
    : null;
  const shape = (item: unknown) => {
    if (Array.isArray(item)) return { type: "array", length: item.length, itemTypes: [...new Set(item.slice(0, 3).map((entry) => typeof entry))] };
    if (typeof item === "string") return { type: "string", length: item.length };
    if (item && typeof item === "object") return { type: "object", keys: Object.keys(item as Record<string, unknown>).slice(0, 20) };
    return { type: typeof item };
  };
  const analysisKey = ["video_analysis", "videoAnalysis", "analysis"].find((key) => record[key] !== undefined);
  return {
    jsonParsed: true,
    keys: Object.keys(record).slice(0, 30),
    analysis: analysisKey ? shape(record[analysisKey]) : null,
    platforms: Object.fromEntries(platforms.map((key) => [key, shape(record[key] ?? nested?.[key])])),
    nestedOutputKeys: nested ? Object.keys(nested).slice(0, 30) : null,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function loadYouTubeStoryboardContext(url: string): Promise<VideoStoryboardContext> {
  const page = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; HookEngine/1.0)" },
    signal: AbortSignal.timeout(18000),
  });
  if (!page.ok) throw new Error("YouTube video metadata request failed (" + page.status + ").");
  const html = await page.text();
  const playerJson = extractJsonObject(html, "ytInitialPlayerResponse");
  if (!playerJson) throw new Error("YouTube did not expose storyboard metadata for this video.");
  const player = JSON.parse(playerJson);
  const spec = player?.storyboards?.playerStoryboardSpecRenderer?.spec;
  if (typeof spec !== "string") throw new Error("This YouTube video has no storyboard frames available.");
  const sheets = parseYouTubeStoryboardSpec(spec, 3);
  if (!sheets.length) throw new Error("YouTube storyboard metadata could not be parsed.");

  const ollamaImages: string[] = [];
  for (const sheet of sheets) {
    const response = await fetch(sheet.url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("A YouTube storyboard image could not be loaded.");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) throw new Error("YouTube returned an invalid storyboard image.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("A storyboard image exceeded the supported size.");
    ollamaImages.push(bytesToBase64(bytes));
  }
  return { sheets, ollamaImages };
}

const TONE_RULES: Record<string, string> = {
  balanced: "Tone: balanced and clear.",
  professional: "Tone: professional and measured.",
  conversational: "Tone: conversational, plain and relaxed, like talking to a friend.",
  confident: "Tone: confident and assertive.",
  witty: "Tone: witty. Every draft needs at least one light joke, playful turn of phrase or sharp observation taken from the source. Never mock people.",
  educational: "Tone: educational. Explain clearly and define any term a newcomer may not know.",
  inspiring: "Tone: uplifting and motivating, without empty hype.",
};
const STYLE_RULES: Record<string, string> = {
  platform_native: "Style: use the natural structure of each platform.",
  storytelling: "Style: storytelling. Each draft is a short story with a concrete setup, a turn and a payoff, built only from events and details in the source.",
  direct: "Style: direct and concise. State the point in the first sentence and cut every unnecessary word.",
  analytical: "Style: analytical. Lead with an insight, then explain the reasoning using the source's evidence.",
  personal: "Style: personal. Use first person only for the source's own speaker or author. Never invent experiences, feelings or opinions for the person posting.",
  bold: "Style: bold. Open with a specific, bold claim taken from the source, then deliver tightly.",
};
const LENGTH_RULES: Record<string, string> = {
  platform_default: "Length: each platform's default length.",
  short: "Length: short. Use the minimum each platform needs.",
  medium: "Length: medium. Give each draft a moderate amount of detail.",
  detailed: "Length: detailed. Include the source's specifics in each draft.",
};

function preferenceRules(preferences: GenerationPreferences): string {
  const rules = [
    "WRITING PREFERENCES (follow every one in every draft):",
    TONE_RULES[preferences.tone] ?? TONE_RULES.balanced,
    STYLE_RULES[preferences.style] ?? STYLE_RULES.platform_native,
    LENGTH_RULES[preferences.length] ?? LENGTH_RULES.platform_default,
  ];
  const audience = preferences.audience.trim().slice(0, 160);
  if (audience) {
    rules.push("Audience: write for " + JSON.stringify(audience) + ". Address this audience directly in at least one draft.");
  }
  return rules.join("\n");
}

function videoPrompt(
  title: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
  transcript: string,
): string {
  const instructions = platforms.map((key) => key.toUpperCase() + ": " + PLATFORM_GUIDANCE[key]).join("\n");
  const outputShape = variationCount === 1
    ? "Return exactly one non-empty string for each requested platform."
    : "Return an array of exactly " + variationCount +
      " complete, distinct, non-empty strings for each requested platform.";
  const transcriptSection = transcript.trim()
    ? "\n\nTRANSCRIPT (primary source for exact wording and sequence):\n" + transcript.slice(0, 60000)
    : "";
  return [
    "You are analyzing a public YouTube video for a creator who wants to understand it deeply and create content that feels naturally spoken.",
    "FIRST produce a substantial, useful video_analysis, then produce the requested platform drafts.",
    "VIDEO ANALYSIS requirements: aim for 700–1,000 words when the source supports it. Use clear headings: Overview; Detailed Summary; Main Ideas and Arguments; Important Examples and Evidence; What the Speaker Emphasizes; Key Takeaways; Speaker Delivery Profile.",
    "The Detailed Summary must follow the actual progression of the video, not collapse it into a generic paragraph. Explain what is said, why it matters, and how each point connects. Preserve nuance, caveats, disagreements and conclusions.",
    "Speaker Delivery Profile: infer observable high-level communication traits from the speech, such as pace, sentence length, vocabulary, formality, energy, humor, directness, rhetorical habits and how the speaker explains ideas. Be specific and evidence-based. Do not guess private personality traits.",
    "VOICE ADAPTATION: write the social drafts with the same broad conversational feel and communication traits identified in the delivery profile, so they sound natural and spoken rather than like generic AI copy. Preserve the speaker's level of energy, directness, complexity and explanatory rhythm. Do not impersonate the person, claim to be them, or copy distinctive catchphrases verbatim.",
    "SOCIAL DRAFT DEPTH: do not make the platform drafts short summaries of the video. Treat each requested format as a finished, publishable piece of content. Follow the per-platform length and structure guidance below; use the available output budget for substance, not filler. Include the speaker's actual reasoning, examples, useful specifics and nuance where supported. Avoid generic introductions, repeated points and vague motivational language. If the video genuinely lacks enough material for a requested length, write the strongest complete version the source supports rather than padding or inventing details.",
    "Keep the video_analysis and social drafts separate: the analysis explains the whole video, while each social draft should independently communicate a coherent, valuable idea to its platform's audience.",
    "Use the transcript for accurate wording and sequence when supplied, and use the video frames for visual context. Never invent facts, quotes, examples, timestamps or details. Do not fabricate timestamps; only include them when directly available and reliable. Every number, name, price, date and quote in a draft must appear in the transcript or the video analysis. Each platform draft takes a different angle, and no point appears in more than one draft. Rewrite transcript sentences in new words instead of copying them. Do not reuse an analogy, example or key phrase across platforms. Do not describe anything as first, unprecedented, impossible or long-expected unless the transcript or the video analysis says so. Never write as if the person posting had the experience or the opinion; attribute experiences to the video's speaker only, and keep any hedge the source uses such as 'may have' or 'appears to'.",
    preferenceRules(preferences),
    outputShape,
    "Video title: " + JSON.stringify(title.slice(0, 300)),
    "Requested formats:\n" + instructions,
    transcriptSection,
    "Return the analysis in video_analysis and only the requested platform drafts in their respective keys.",
  ].join("\n\n");
}

async function fallbackVideoRaw(
  provider: "OpenRouter" | "Groq" | "Ollama",
  url: string,
  prompt: string,
  storyboard?: VideoStoryboardContext,
): Promise<{ raw: string; model: string }> {
  let endpoint = "";
  let model = "";
  let body: Record<string, unknown>;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "OpenRouter") {
    if (!OPENROUTER_API_KEY) throw new Error("OpenRouter is not configured.");
    endpoint = "https://openrouter.ai/api/v1/chat/completions";
    model = OPENROUTER_VIDEO_MODEL;
    headers.Authorization = "Bearer " + OPENROUTER_API_KEY;
    body = {
      model,
      messages: [
        { role: "system", content: GENERATION_SYSTEM_INSTRUCTION },
        { role: "user", content: [
          { type: "text", text: prompt },
          { type: "video_url", video_url: { url } },
        ] },
      ],
      response_format: { type: "json_object" },
      max_tokens: 14000,
      stream: false,
    };
  } else {
    if (!storyboard?.sheets.length) throw new Error("No sampled video frames are available for " + provider + ".");
    const frameNote = "VISUAL INPUT: The attached images are YouTube storyboard contact sheets sampled across the video. Each sheet contains a grid of still frames; inspect the tiles left-to-right and top-to-bottom. Use them to understand scenes, on-screen text, demonstrations, objects and visual changes. Do not treat a storyboard as full-motion footage.";
    if (provider === "Groq") {
      if (!GROQ_API_KEY) throw new Error("Groq is not configured.");
      endpoint = "https://api.groq.com/openai/v1/chat/completions";
      model = GROQ_VIDEO_MODEL;
      headers.Authorization = "Bearer " + GROQ_API_KEY;
      body = {
        model,
        messages: [
          { role: "system", content: GENERATION_SYSTEM_INSTRUCTION },
          { role: "user", content: [
            { type: "text", text: frameNote + "\n\n" + prompt },
            ...storyboard.sheets.map((sheet) => ({
              type: "image_url",
              image_url: { url: sheet.url },
            })),
          ] },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 14000,
        stream: false,
      };
    } else {
      if (!OLLAMA_API_KEY) throw new Error("Ollama Cloud is not configured.");
      endpoint = "https://ollama.com/api/chat";
      model = OLLAMA_VIDEO_MODEL;
      headers.Authorization = "Bearer " + OLLAMA_API_KEY;
      body = {
        model,
        messages: [{
          role: "user",
          content: GENERATION_SYSTEM_INSTRUCTION + "\n\n" + frameNote + "\n\n" + prompt,
          images: storyboard.ollamaImages,
        }],
        format: "json",
        stream: false,
        options: { temperature: 0.7, num_predict: 14000 },
      };
    }
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data?.error?.message === "string"
      ? data.error.message.slice(0, 500)
      : typeof data?.error === "string" ? data.error.slice(0, 500) : "No provider error details.";
    throw Object.assign(new Error(provider + " video request failed: " + detail), { status: response.status });
  }
  const raw = provider === "Ollama"
    ? data?.message?.content
    : data?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(provider + " returned an empty video analysis.");
  return { raw, model };
}

async function authenticate(req: Request): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Authentication service is not configured.");
  }
  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return typeof user?.id === "string" ? user.id : null;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    console.error("HookEngine RPC failed", name, response.status);
    const error = new Error("Could not update your usage. Please try again.");
    (error as Error & { status?: number }).status = response.status >= 500 ? 503 : 502;
    throw error;
  }
  return await response.json();
}

async function reserve(userId: string, payload: GenerationPayload) {
  return await rpc("hookengine_reserve_generation", {
    p_user_id: userId,
    p_source_type: payload.sourceMode === "youtube_video" ? "youtube_video" : "article",
    p_source_title: payload.title,
    p_source_url: payload.sourceUrl,
    p_source_text: payload.sourceMode === "text" ? payload.text.trim() : "",
    p_action_type: payload.actionType,
    p_parent_generation_id: payload.parentGenerationId,
    p_selected_platforms: payload.platforms,
  });
}

async function finish(
  userId: string,
  id: string,
  status: "completed" | "failed",
  outputs: Record<string, string[]> = {},
  platforms: string[] = [],
  provider: string | null = null,
  model: string | null = null,
  inputTokens: number | null = null,
  outputTokens: number | null = null,
  latencyMs: number | null = null,
  errorMessage: string | null = null,
  videoAnalysis: string | null = null,
) {
  const finalized = await rpc("hookengine_finish_generation", {
    p_generation_id: id,
    p_user_id: userId,
    p_status: status,
    p_x_thread: serializeOutput(outputs.x_thread),
    p_linkedin_post: serializeOutput(outputs.linkedin_post),
    p_tiktok_hooks: serializeOutput(outputs.tiktok_hooks),
    p_error_message: errorMessage,
    p_outputs: videoAnalysis ? { ...outputs, video_analysis: videoAnalysis } : outputs,
    p_selected_platforms: platforms,
    p_provider: provider,
    p_model: model,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_latency_ms: latencyMs,
  });
  if (finalized !== true) throw new Error("Generation reservation could not be finalized.");
}

function promptFor(
  title: string,
  sourceText: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
) {
  const instructions = platforms.map((key) => key.toUpperCase() + ": " + PLATFORM_GUIDANCE[key]).join("\n");
  const outputShape = variationCount === 1
    ? "For each requested platform, return exactly one non-empty string."
    : "For each requested platform, return an array containing exactly " + variationCount +
      " complete, distinct, non-empty strings. Do not join alternatives into one string.";
  return [
    "Repurpose the supplied source into platform-native drafts.",
    "Preserve its meaning. Never invent statistics, quotes, events, facts or personal experiences.",
    preferenceRules(preferences),
    "AUTHOR VOICE: first infer the author's observable writing style from the source text, such as sentence length, formality, directness, how they explain ideas and how they use examples. Write the drafts in that same broad voice so they sound natural and spoken rather than like generic AI copy. Do not impersonate the author, do not claim to be them, and do not copy distinctive phrases verbatim. The drafts are for the person publishing them, so keep them in their own words and use only facts from the source.",
    "NO REPETITION: make each point appear once across all outputs. Do not copy source sentences into hooks, posts or scripts; rewrite them in new words. Each hook must argue a different idea, and the script must be a fresh spoken telling rather than a restatement of the source.",
    "ACCURACY AND VOICE: never write as if the person posting had the experience or the opinion. Do not describe anything as first, unprecedented, impossible or long-expected unless the source says so, and keep any hedge the source uses such as \"may have\" or \"appears to\".",
    outputShape,
    "Source title: " + JSON.stringify(title.slice(0, 300)),
    "Requested formats:\n" + instructions,
    "SOURCE TEXT (untrusted reference material):\n" + sourceText,
  ].join("\n\n");
}

async function geminiText(prompt: string, platforms: string[], variationCount: number): Promise<TextGenerationResult> {
  if (!GEMINI_API_KEY) {
    const error = new Error("Gemini is not configured.");
    (error as Error & { status?: number }).status = 503;
    throw error;
  }
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODEL) + ":generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GENERATION_SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schemaFor(platforms, variationCount),
          maxOutputTokens: 6000,
        },
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Gemini request failed.");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const raw = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";
  const outputs = parseOutputs(raw, platforms, variationCount);
  if (!outputs) throw new Error("Gemini returned an invalid draft format.");
  const usage = data?.usageMetadata || {};
  return {
    outputs,
    model: GEMINI_MODEL,
    inputTokens: Number.isInteger(usage.promptTokenCount) ? usage.promptTokenCount : null,
    outputTokens: Number.isInteger(usage.candidatesTokenCount) ? usage.candidatesTokenCount : null,
  };
}

async function compatibleText(
  provider: "Groq" | "OpenRouter" | "Ollama",
  prompt: string,
  platforms: string[],
  variationCount: number,
): Promise<TextGenerationResult> {
  const isOpenAICompatible = provider !== "Ollama";
  const isGroq = provider === "Groq";
  const key = provider === "Groq" ? GROQ_API_KEY : provider === "OpenRouter" ? OPENROUTER_API_KEY : OLLAMA_API_KEY;
  if (!key) throw new Error(provider + " is not configured.");
  const url = provider === "Groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : provider === "OpenRouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://ollama.com/api/chat";
  const model = provider === "Groq" ? GROQ_MODEL : provider === "OpenRouter" ? OPENROUTER_TEXT_MODEL : OLLAMA_MODEL;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: GENERATION_SYSTEM_INSTRUCTION },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      ...(isOpenAICompatible
        ? { temperature: 0.7, max_tokens: 6000 }
        : { stream: false, format: "json", options: { temperature: 0.7, num_predict: 6000 } }),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(provider + " request failed.");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const raw = isOpenAICompatible ? data?.choices?.[0]?.message?.content : data?.message?.content;
  const outputs = parseOutputs(typeof raw === "string" ? raw : "", platforms, variationCount);
  if (!outputs) throw new Error(provider + " returned an invalid draft format.");
  const usage = isOpenAICompatible ? data?.usage || {} : {};
  const inputTokens = isOpenAICompatible ? usage.prompt_tokens : data?.prompt_eval_count;
  const outputTokens = isOpenAICompatible ? usage.completion_tokens : data?.eval_count;
  return {
    outputs,
    model,
    inputTokens: Number.isInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isInteger(outputTokens) ? outputTokens : null,
  };
}

async function generateText(prompt: string, platforms: string[], variationCount: number, sourceText = "") {
  const result = await runWithProviderFallback(
    () => geminiText(prompt, platforms, variationCount),
    [
      ...(GROQ_API_KEY ? [{ name: "Groq", run: () => compatibleText("Groq", prompt, platforms, variationCount) }] : []),
      ...(OPENROUTER_API_KEY ? [{ name: "OpenRouter", run: () => compatibleText("OpenRouter", prompt, platforms, variationCount) }] : []),
      ...(OLLAMA_API_KEY ? [{ name: "Ollama", run: () => compatibleText("Ollama", prompt, platforms, variationCount) }] : []),
    ],
    (provider, error) => console.error(provider + " fallback failed", safeErrorStatus(error)),
  );
  const value = { ...result.value, provider: result.provider, fallbackUsed: result.fallbackUsed };
  if (!sourceText.trim()) return value;
  const issues = draftPolicyIssues(value.outputs, platforms, sourceText);
  if (!issues.length) return value;
  console.warn("Text drafts failed policy checks; repairing once.", issues);
  try {
    const repaired = await generateText(
      prompt + "\n\nPREVIOUS DRAFTS (rewrite them; do not reuse their sentences, claims or analogies):\n" +
        JSON.stringify(value.outputs) + "\n\nFIX THESE PROBLEMS:\n" + issues.join("\n"),
      platforms,
      variationCount,
    );
    const remaining = draftPolicyIssues(repaired.outputs, platforms, sourceText);
    return remaining.length < issues.length ? repaired : value;
  } catch (error) {
    console.warn("Text repair failed; keeping first drafts.", safeErrorStatus(error));
    return value;
  }
}


async function generateYouTubeGemini(
  url: string,
  title: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
  transcript: string,
  model: string = GEMINI_MODEL,
): Promise<TextGenerationResult & { analysis: string; provider: string; fallbackUsed: boolean }> {
  if (!GEMINI_API_KEY) {
    const error = new Error("Gemini video analysis is not configured.");
    (error as Error & { status?: number }).status = 503;
    throw error;
  }
  if (!validYouTube(url)) throw new Error("Open a public YouTube video and try again.");
  const instructions = platforms.map((key) => key.toUpperCase() + ": " + PLATFORM_GUIDANCE[key]).join("\n");
  const outputShape = variationCount === 1
    ? "Return exactly one non-empty string for each requested platform."
    : "Return an array of exactly " + variationCount +
      " complete, distinct, non-empty strings for each requested platform.";
  const transcriptSection = transcript.trim()
    ? "\n\nTRANSCRIPT (primary source for exact wording and sequence):\n" + transcript.slice(0, 60000)
    : "";
  const prompt = [
    "You are analyzing a public YouTube video for a creator who wants to understand it deeply and create content that feels naturally spoken.",
    "FIRST produce a substantial, useful video_analysis, then produce the requested platform drafts.",
    "VIDEO ANALYSIS requirements: aim for 700–1,000 words when the source supports it. Use clear headings: Overview; Detailed Summary; Main Ideas and Arguments; Important Examples and Evidence; What the Speaker Emphasizes; Key Takeaways; Speaker Delivery Profile.",
    "The Detailed Summary must follow the actual progression of the video, not collapse it into a generic paragraph. Explain what is said, why it matters, and how each point connects. Preserve nuance, caveats, disagreements and conclusions.",
    "Speaker Delivery Profile: infer observable high-level communication traits from the speech, such as pace, sentence length, vocabulary, formality, energy, humor, directness, rhetorical habits and how the speaker explains ideas. Be specific and evidence-based. Do not guess private personality traits.",
    "VOICE ADAPTATION: write the social drafts with the same broad conversational feel and communication traits identified in the delivery profile, so they sound natural and spoken rather than like generic AI copy. Preserve the speaker's level of energy, directness, complexity and explanatory rhythm. Do not impersonate the person, claim to be them, or copy distinctive catchphrases verbatim.",
    "SOCIAL DRAFT DEPTH: do not make the platform drafts short summaries of the video. Treat each requested format as a finished, publishable piece of content. Follow the per-platform length and structure guidance below; use the available output budget for substance, not filler. Include the speaker's actual reasoning, examples, useful specifics and nuance where supported. Avoid generic introductions, repeated points and vague motivational language. If the video genuinely lacks enough material for a requested length, write the strongest complete version the source supports rather than padding or inventing details.",
    "Keep the video_analysis and social drafts separate: the analysis explains the whole video, while each social draft should independently communicate a coherent, valuable idea to its platform's audience.",
    "Use the transcript for accurate wording and sequence when supplied, and use the video for visual context. Never invent facts, quotes, examples, timestamps or details. Do not fabricate timestamps; only include them when directly available and reliable. Every number, name, price, date and quote in a draft must appear in the transcript or the video analysis. Each platform draft takes a different angle, and no point appears in more than one draft. Rewrite transcript sentences in new words instead of copying them. Do not reuse an analogy, example or key phrase across platforms. Do not describe anything as first, unprecedented, impossible or long-expected unless the transcript or the video analysis says so. Never write as if the person posting had the experience or the opinion; attribute experiences to the video's speaker only, and keep any hedge the source uses such as 'may have' or 'appears to'.",
    preferenceRules(preferences),
    outputShape,
    "Video title: " + JSON.stringify(title.slice(0, 300)),
    "Requested formats:\n" + instructions,
    transcriptSection,
    "Return the analysis in video_analysis and only the requested platform drafts in their respective keys.",
  ].join("\n\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      model,
      system_instruction: GENERATION_SYSTEM_INSTRUCTION,
      input: [
        { type: "video", uri: url, processing: "static" },
        { type: "text", text: prompt },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: interactionsSchemaFor(platforms, variationCount),
      },
      generation_config: { max_output_tokens: 14000 },
      store: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = typeof data?.error?.message === "string"
      ? data.error.message.slice(0, 1200)
      : typeof data?.error?.status === "string"
        ? data.error.status
        : "No error details returned.";
    console.error("Gemini video analysis request rejected.", response.status, apiMessage);
    const error = new Error("Could not analyze this YouTube video.");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  if (data?.status && data.status !== "completed") {
    console.error("Gemini video interaction did not complete.", JSON.stringify({
      status: data.status,
      model: data.model ?? null,
      hasOutputText: typeof data.output_text === "string",
      stepTypes: Array.isArray(data.steps) ? data.steps.map((step: { type?: string }) => step?.type ?? "unknown") : [],
    }));
    throw new Error("Video analysis did not complete. Please try again.");
  }
  let raw = typeof data.output_text === "string" ? data.output_text : "";
  if (!raw) {
    const blocks: Array<{ type?: string; text?: string }> = [];
    for (const step of data.steps || []) {
      if (step?.type === "model_output" && Array.isArray(step.content)) blocks.push(...step.content);
    }
    raw = blocks.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("\n");
  }
  let parsed = parseVideoOutputs(raw, platforms, variationCount);
  if (!parsed) {
    console.error("Gemini video response could not be parsed.", JSON.stringify({
      status: data?.status ?? null,
      model: data?.model ?? null,
      outputTextLength: raw.length,
      outputTextPresent: raw.length > 0,
      stepTypes: Array.isArray(data?.steps) ? data.steps.map((step: { type?: string }) => step?.type ?? "unknown") : [],
      requestedPlatforms: platforms,
      variationCount,
      outputShape: summarizeGeminiVideoOutput(raw, platforms),
    }));
    throw new Error("Gemini returned an invalid video analysis or draft format.");
  }

  // Repair each failing platform independently. Bundling several formats and the
  // full video analysis into one repair response caused Gemini to keep compressing
  // every draft instead of expanding the formats that actually failed.
  let qualityIssues = [...videoDraftQualityIssues(parsed.outputs, platforms, variationCount), ...draftPolicyIssues(parsed.outputs, platforms, transcript + "\n" + parsed.analysis)];
  if (qualityIssues.length) {
    console.warn("YouTube social drafts failed depth checks; repairing platforms separately.", qualityIssues);
    const failingPlatforms = [...new Set(qualityIssues.map((issue) => issue.split(":")[0].replace(/ version \\d+$/, "")))];
    for (const platform of failingPlatforms) {
      const failedDrafts = parsed.outputs[platform] || [];
      const platformPrompt = [
        "Write complete, publishable social content for exactly one platform. This is a focused repair, not a summary.",
        "Meet the full length and structure requirements below for EVERY requested variation. The minimum word count is a hard requirement.",
        "Use the video and transcript as source material. Add source-supported reasoning, context, concrete examples and useful specifics. Never invent facts, quotes, examples or personal experiences. Do not pad or repeat.",
        "Create exactly " + variationCount + " distinct variations. Each must independently meet the minimum length.",
        "Video title: " + JSON.stringify(title.slice(0, 300)),
        "Platform: " + platform,
        "Platform requirements: " + PLATFORM_GUIDANCE[platform],
        "Minimum words per variation: " + ({ x_thread: 150, linkedin_post: 160, tiktok_hooks: 130, instagram_caption: 110, threads_posts: 100, facebook_post: 120 } as Record<string, number>)[platform],
        preferenceRules(preferences),
        "Video analysis for context: " + parsed.analysis,
        "Previous short drafts (rewrite them substantially; do not merely rephrase): " + JSON.stringify(failedDrafts),
        "Fix these problems: " + qualityIssues.filter((issue) => issue.startsWith(platform + ":") || issue.startsWith(platform + " version")).join("; "),
        transcriptSection,
        "Return only a JSON object with this exact shape: " + JSON.stringify({ [platform]: Array.from({ length: variationCount }, () => "complete draft") }),
      ].join("\n\n");
      const platformResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          model,
          system_instruction: GENERATION_SYSTEM_INSTRUCTION,
          input: [
            { type: "video", uri: url, processing: "static" },
            { type: "text", text: platformPrompt },
          ],
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: {
              type: "object",
              properties: {
                [platform]: variationCount > 1
                  ? { type: "array", items: { type: "string" }, minItems: variationCount, maxItems: variationCount }
                  : { type: "string" },
              },
              required: [platform],
              additionalProperties: false,
            },
          },
          generation_config: { max_output_tokens: 5000 },
          store: false,
        }),
      });
      const platformData = await platformResponse.json().catch(() => ({}));
      if (!platformResponse.ok || (platformData?.status && platformData.status !== "completed")) {
        throw new Error("The " + platform + " drafts could not be expanded. Please try again.");
      }
      let platformRaw = typeof platformData.output_text === "string" ? platformData.output_text : "";
      if (!platformRaw) {
        const blocks: Array<{ type?: string; text?: string }> = [];
        for (const step of platformData.steps || []) {
          if (step?.type === "model_output" && Array.isArray(step.content)) blocks.push(...step.content);
        }
        platformRaw = blocks.filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text).join("\n");
      }
      const repaired = parseOutputs(platformRaw, [platform], variationCount);
      if (!repaired) throw new Error("The " + platform + " drafts returned an invalid format. Please try again.");
      const score = (drafts: string[]) =>
        videoDraftQualityIssues({ [platform]: drafts }, [platform], variationCount).length +
        draftPolicyIssues({ [platform]: drafts }, [platform], transcript + "\n" + parsed.analysis).length;
      if (score(repaired[platform] || []) <= score(parsed.outputs[platform] || [])) {
        parsed.outputs[platform] = repaired[platform];
      }
    }
    qualityIssues = [...videoDraftQualityIssues(parsed.outputs, platforms, variationCount), ...draftPolicyIssues(parsed.outputs, platforms, transcript + "\n" + parsed.analysis)];
    // Only length failures block the result. Policy issues are repaired once above but never fail the request.
    if (videoDraftQualityIssues(parsed.outputs, platforms, variationCount).length) {
      console.error("YouTube social drafts remained below minimum depth after platform repair.", qualityIssues);
      throw new Error("The video did not produce sufficiently detailed social drafts. Please try again with another video.");
    }
  }

  const usage = data?.usage || {};
  return {
    outputs: parsed.outputs,
    analysis: parsed.analysis,
    model: typeof data.model === "string" ? data.model : model,
    inputTokens: Number.isInteger(usage.total_input_tokens) ? usage.total_input_tokens : null,
    outputTokens: Number.isInteger(usage.total_output_tokens) ? usage.total_output_tokens : null,
    provider: "Gemini",
    fallbackUsed: false,
  };
}

async function generateYouTube(
  url: string,
  title: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
  transcript: string,
): Promise<TextGenerationResult & { analysis: string; provider: string; fallbackUsed: boolean }> {
  // YouTube analysis uses Gemini only. The OpenRouter, Groq and Ollama video paths are not reliable enough to fall back to.
  // Gemini returns 503 or 429 during demand spikes. Retry the primary model, then try the fallback Gemini model.
  // Every attempt stays on Gemini.
  const models = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
    ? [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]
    : [GEMINI_MODEL];
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await generateYouTubeGemini(url, title, platforms, preferences, variationCount, transcript, model);
      } catch (error) {
        const status = safeErrorStatus(error);
        const detail = error instanceof Error ? error.message.slice(0, 500) : "Unknown provider error.";
        console.error("YouTube Gemini analysis failed.", model, "attempt " + attempt, status, detail);
        const explicitStatus = (error as { status?: unknown } | null)?.status;
        const retryable = explicitStatus === 503 || explicitStatus === 429;
        if (!retryable) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 6000));
      }
    }
  }
  throw new Error("AI providers are temporarily unavailable. Please try again shortly.");
}

async function runFallbackVideoGeneration(
  provider: "OpenRouter" | "Groq" | "Ollama",
  url: string,
  title: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
  transcript: string,
  storyboard?: VideoStoryboardContext,
): Promise<TextGenerationResult & { analysis: string; provider: string; fallbackUsed: boolean }> {
  const prompt = videoPrompt(title, platforms, preferences, variationCount, transcript);
  const result = await fallbackVideoRaw(provider, url, prompt, storyboard);
  const parsed = parseVideoOutputs(result.raw, platforms, variationCount);
  if (!parsed) throw new Error(provider + " returned an invalid video analysis or draft format.");
  let qualityIssues = [...videoDraftQualityIssues(parsed.outputs, platforms, variationCount), ...draftPolicyIssues(parsed.outputs, platforms, transcript + "\n" + parsed.analysis)];
  if (qualityIssues.length) {
    console.warn("Video fallback drafts failed depth checks; repairing each platform separately.", provider, qualityIssues);
    const failingPlatforms = [...new Set(qualityIssues.map((issue) => issue.split(":")[0].replace(/ version \\d+$/, "")))];
    for (const platform of failingPlatforms) {
      const minimumWords = ({
        x_thread: 150,
        linkedin_post: 160,
        tiktok_hooks: 130,
        instagram_caption: 110,
        threads_posts: 100,
        facebook_post: 120,
      } as Record<string, number>)[platform] || 100;
      const repairPrompt = [
        "Write complete, publishable social content for exactly one platform. This is a focused repair, not a summary.",
        "Meet the minimum word count of " + minimumWords + " words for EVERY variation. This is a hard requirement.",
        "Use the supplied video visuals, analysis and transcript as source material. Add source-supported reasoning, context, concrete examples and useful specifics. Never invent facts, quotes, examples or personal experiences. Do not pad or repeat.",
        "Create exactly " + variationCount + " distinct variations.",
        "Video title: " + JSON.stringify(title.slice(0, 300)),
        "Platform: " + platform,
        "Platform requirements: " + PLATFORM_GUIDANCE[platform],
        preferenceRules(preferences),
        "Video analysis for context: " + parsed.analysis,
        "Previous short drafts (rewrite them substantially): " + JSON.stringify(parsed.outputs[platform] || []),
        transcript.trim() ? "TRANSCRIPT:\n" + transcript.slice(0, 60000) : "",
        "Return only this JSON object: " + JSON.stringify({
          [platform]: Array.from({ length: variationCount }, () => "complete draft"),
        }),
      ].join("\n\n");
      const repairedRaw = await fallbackVideoRaw(provider, url, repairPrompt, storyboard);
      const repaired = parseOutputs(repairedRaw.raw, [platform], variationCount);
      if (!repaired) throw new Error(provider + " returned an invalid repaired " + platform + " draft.");
      const score = (drafts: string[]) =>
        videoDraftQualityIssues({ [platform]: drafts }, [platform], variationCount).length +
        draftPolicyIssues({ [platform]: drafts }, [platform], transcript + "\n" + parsed.analysis).length;
      if (score(repaired[platform] || []) <= score(parsed.outputs[platform] || [])) {
        parsed.outputs[platform] = repaired[platform];
      }
    }
    qualityIssues = [...videoDraftQualityIssues(parsed.outputs, platforms, variationCount), ...draftPolicyIssues(parsed.outputs, platforms, transcript + "\n" + parsed.analysis)];
    if (qualityIssues.length) {
      throw new Error(provider + " could not meet the required draft depth: " + qualityIssues.join("; ").slice(0, 350));
    }
  }
  return {
    outputs: parsed.outputs,
    analysis: parsed.analysis,
    model: result.model,
    inputTokens: null,
    outputTokens: null,
    provider,
    fallbackUsed: true,
  };
}

// The rightmost X-Forwarded-For entry is the address appended by the platform proxy.
// Anything to its left is client-supplied and is ignored.
function trustedClientIp(req: Request): string | null {
  const parts = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const last = parts.at(-1);
  return last && last.length <= 64 ? last : null;
}

async function anonymousIpBucket(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ANON_IP_SALT),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleAnonymousGeneration(req: Request): Promise<Response> {
  const cors = buildCorsHeaders(req.headers.get("origin"), ALLOWED_ORIGINS);
  const reply = (data: unknown, status = 200) => jsonReply(data, status, cors);
  if (!ANON_IP_SALT || !SUPABASE_SERVICE_ROLE_KEY) {
    return reply({ error: "Anonymous generation is not configured." }, 503);
  }

  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return reply({ error: "Request body is too large." }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return reply({ error: "Request body must be valid JSON." }, 400);
  }
  const validation = validateGenerationPayload(body);
  if (!validation.ok) return reply({ error: validation.error }, 400);
  const payload = validation.value;

  if (!payload.platforms.every((platform) => ANONYMOUS_PLATFORMS.includes(platform))) {
    return reply({ error: "Only X, LinkedIn and TikTok are available without an account." }, 403);
  }

  const isVideo = payload.sourceMode === "youtube_video";
  const cost = isVideo ? 5 : 1;

  const ip = trustedClientIp(req);
  if (!ip) return reply({ error: "Could not identify this connection. Please try again." }, 400);
  const bucket = await anonymousIpBucket(ip);

  let decision: any;
  try {
    decision = await rpc("hookengine_reserve_anonymous", {
      p_ip_hash: bucket,
      p_ip_limit: ANONYMOUS_IP_DAILY_CREDITS,
      p_global_limit: GLOBAL_DAILY_CREDIT_CAP,
      p_cost: cost,
    });
  } catch (error) {
    console.error("HookEngine anonymous reservation failed", safeErrorStatus(error));
    return reply({ error: "Could not check usage. Please try again." }, 503);
  }
  if (!decision?.allowed) {
    const globalLimit = decision?.reason === "global_limit";
    return reply({
      error: globalLimit
        ? "Global daily limit reached. Try again tomorrow."
        : "Daily limit reached for this connection. Try again tomorrow.",
      reason: globalLimit ? "global_limit" : "ip_limit",
      resetAt: decision?.resets_at ?? null,
    }, 429);
  }

  const startedAt = performance.now();
  try {
    // Videos use the same provider chain as account users; text uses generateText.
    const result = isVideo
      ? await generateYouTube(payload.sourceUrl, payload.title, payload.platforms, payload.preferences, 1, payload.text)
      : await generateText(
        promptFor(payload.title, payload.text.trim(), payload.platforms, payload.preferences, 1),
        payload.platforms,
        1,
        payload.text,
      );
    const videoAnalysis = "analysis" in result && typeof result.analysis === "string" ? result.analysis : null;
    return reply({
      outputs: videoAnalysis ? { ...result.outputs, video_analysis: videoAnalysis } : result.outputs,
      provider: result.provider,
      fallbackUsed: result.fallbackUsed,
      usage: {
        plan: "anonymous",
        creditsReserved: cost,
        remainingDaily: decision.ip_remaining ?? null,
        latencyMs: Math.round(performance.now() - startedAt),
      },
    });
  } catch (error) {
    // Give the reserved credits back when no draft was produced.
    try {
      await rpc("hookengine_refund_anonymous", { p_ip_hash: bucket, p_cost: cost });
    } catch (refundError) {
      console.error("Could not refund anonymous generation credits.", safeErrorStatus(refundError));
    }
    console.error("HookEngine anonymous generation failed.", safeErrorStatus(error),
      error instanceof Error ? error.message.slice(0, 300) : "Unknown error");
    const message = error instanceof Error ? error.message : "";
    const publicMessage = message === "AI providers are temporarily unavailable. Please try again shortly." ||
        message === "Could not analyze this YouTube video." ||
        message === "Video analysis did not complete. Please try again." ||
        message === "Open a public YouTube video and try again."
      ? message
      : "Generation failed. Your credits were not used. Please try again.";
    return reply({ error: publicMessage }, 502);
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const cors = buildCorsHeaders(req.headers.get("origin"), ALLOWED_ORIGINS);
  const reply = (data: unknown, status = 200) => jsonReply(data, status, cors);
  if (req.method === "OPTIONS") return corsPreflight(cors);
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return reply({ error: "Request body is too large." }, 413);
  }

  const hasBearer = /^Bearer\s+\S+/i.test(req.headers.get("authorization") || "");
  const userId = await authenticate(req);
  // A token that fails verification is still rejected; only requests with no token go anonymous.
  if (!userId && hasBearer) return reply({ error: "Sign in to HookEngine to use your allowance." }, 401);
  if (!userId) return await handleAnonymousGeneration(req);
  if (!SUPABASE_SERVICE_ROLE_KEY) return reply({ error: "Usage service is not configured." }, 503);

  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return reply({ error: "Request body is too large." }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return reply({ error: "Request body must be valid JSON." }, 400);
  }

  const validation = validateGenerationPayload(body);
  if (!validation.ok) return reply({ error: validation.error }, 400);
  const payload = validation.value;

  let reservation: any;
  try {
    reservation = await reserve(userId, payload);
  } catch (error) {
    console.error("HookEngine reservation failed", safeErrorStatus(error));
    return reply({ error: "Could not check your plan or reserve credits. Please try again." }, 503);
  }

  if (!reservation?.allowed) {
    const reason = String(reservation?.reason || "reservation_denied");
    return reply({
      error: reservation?.message || "This request is not available on your current plan.",
      reason,
      plan: reservation?.plan || "free",
      creditsBalance: reservation?.credits_balance ?? null,
      creditsRequired: reservation?.credits_required ?? null,
      dailyUsed: reservation?.used ?? reservation?.daily_used ?? null,
      dailyLimit: reservation?.daily_limit ?? null,
      allowedPlatforms: reservation?.allowed_platforms ?? null,
      resetAt: reservation?.reset_at ?? null,
      limitReached: reservationLimitReached(reason),
    }, reservationHttpStatus(reason));
  }

  const variationCount = Number(reservation.versions_per_generation) || 1;
  const expectedCost = payload.actionType === "regeneration" ? 1 : payload.sourceMode === "youtube_video" ? 5 : 1;
  const validPlan = ["free", "trial", "pro", "lifetime"].includes(reservation.plan);
  const validGenerationId = typeof reservation.generation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.generation_id);
  if (!validGenerationId || !validPlan ||
      !Number.isInteger(variationCount) || variationCount < 1 || variationCount > 3 ||
      reservation.credits_reserved !== expectedCost ||
      !Array.isArray(reservation.allowed_platforms) ||
      !payload.platforms.every((platform) => reservation.allowed_platforms.includes(platform))) {
    console.error("Reservation returned invalid entitlement metadata.");
    if (validGenerationId) {
      try {
        await finish(userId, reservation.generation_id, "failed", {}, [], null, null, null, null, 0,
          "Invalid entitlement metadata.");
      } catch (error) {
        console.error("Could not refund invalid entitlement reservation.", safeErrorStatus(error));
      }
    }
    return reply({ error: "Your plan settings could not be verified. Please contact support." }, 503);
  }

  const startedAt = performance.now();
  try {
    const result = payload.sourceMode === "youtube_video"
      ? await generateYouTube(payload.sourceUrl, payload.title, payload.platforms, payload.preferences, variationCount, payload.text)
      : await generateText(
        promptFor(payload.title, payload.text.trim(), payload.platforms, payload.preferences, variationCount),
        payload.platforms,
        variationCount,
        payload.text,
      );
    const latencyMs = Math.round(performance.now() - startedAt);
    const videoAnalysis = "analysis" in result && typeof result.analysis === "string" ? result.analysis : null;
    const persistedOutputs = videoAnalysis ? { ...result.outputs, video_analysis: videoAnalysis } : result.outputs;
    await finish(
      userId,
      reservation.generation_id,
      "completed",
      result.outputs,
      payload.platforms,
      result.provider,
      result.model,
      result.inputTokens,
      result.outputTokens,
      latencyMs,
      null,
      videoAnalysis,
    );
    return reply({
      outputs: persistedOutputs,
      provider: result.provider,
      fallbackUsed: result.fallbackUsed,
      usage: {
        plan: reservation.plan,
        creditsReserved: reservation.credits_reserved,
        creditsBalance: reservation.credits_balance,
        dailyUsed: reservation.daily_used,
        dailyLimit: reservation.daily_limit,
        remainingDaily: reservation.remaining_daily,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed.";
    const latencyMs = Math.round(performance.now() - startedAt);
    try {
      await finish(userId, reservation.generation_id, "failed", {}, [], null, null, null, null, latencyMs, message);
    } catch (finalizeError) {
      console.error("Could not record failed generation.", safeErrorStatus(finalizeError));
    }
    console.error("HookEngine generation failed.", safeErrorStatus(error),
      error instanceof Error ? error.message.slice(0, 300) : "Unknown error");
    const publicMessage = message === "AI providers are temporarily unavailable. Please try again shortly." ||
        message === "Could not analyze this YouTube video." ||
        message === "Video analysis did not complete. Please try again."
      ? message
      : "Generation failed. Your reserved credits will be refunded where eligible. Please try again.";
    return reply({ error: publicMessage }, 502);
  }
}

Deno.serve(async (req: Request) => {
  try {
    return await handleRequest(req);
  } catch (error) {
    console.error("HookEngine request handler failed.", safeErrorStatus(error));
    return jsonReply(
      { error: "HookEngine could not process this request. Please try again." },
      503,
      buildCorsHeaders(req.headers.get("origin"), ALLOWED_ORIGINS),
    );
  }
});

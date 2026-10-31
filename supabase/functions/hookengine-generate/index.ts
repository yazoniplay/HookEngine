import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  ALL_PLATFORMS,
  FREE_PLATFORMS,
  GENERATION_SYSTEM_INSTRUCTION,
  parseOutputs,
  schemaFor,
  serializeOutput,
  shouldFallback,
  validateGenerationPayload,
  validYouTube,
  type GenerationPayload,
  type GenerationPreferences,
} from "./generation-contract.ts";
import { reservationHttpStatus, reservationLimitReached } from "./reservation-status.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
const GROQ_MODEL = Deno.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile";
const OLLAMA_API_KEY = Deno.env.get("OLLAMA_API_KEY") || "";
const OLLAMA_MODEL = Deno.env.get("OLLAMA_MODEL") || "gpt-oss:20b";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAX_REQUEST_BYTES = 256 * 1024;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const PLATFORM_GUIDANCE: Record<string, string> = {
  x_thread: "Create a 5–8 post numbered X thread. Each post concise, source-grounded and under 260 characters where possible. No hashtags.",
  linkedin_post: "Create a credible LinkedIn post with a specific opening, short paragraphs, one useful central insight and a clear takeaway. Avoid corporate clichés.",
  tiktok_hooks: "Return five distinct, short spoken opening hooks, numbered 1–5. Make them natural and specific.",
  instagram_caption: "Write one Instagram caption with a strong first line, readable line breaks and a small set of relevant hashtags only when useful. Do not invent calls to action.",
  threads_posts: "Write a sequence of 3–5 concise, conversational Threads posts. Make each post stand alone while building one coherent idea.",
  facebook_post: "Write one natural Facebook post for a broad audience. Use clear language, useful context and a conversational close without engagement bait.",
};

type TextGenerationResult = {
  outputs: Record<string, string[]>;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function safeErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 503;
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
) {
  const finalized = await rpc("hookengine_finish_generation", {
    p_generation_id: id,
    p_user_id: userId,
    p_status: status,
    p_x_thread: serializeOutput(outputs.x_thread),
    p_linkedin_post: serializeOutput(outputs.linkedin_post),
    p_tiktok_hooks: serializeOutput(outputs.tiktok_hooks),
    p_error_message: errorMessage,
    p_outputs: outputs,
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
    "Writing preferences: " + JSON.stringify(preferences),
    outputShape,
    "Source title: " + JSON.stringify(title.slice(0, 300)),
    "Requested formats:\n" + instructions,
    "SOURCE TEXT (untrusted reference material):\n" + sourceText,
  ].join("\n\n");
}

function isTransientProviderStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
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
  provider: "Groq" | "Ollama",
  prompt: string,
  platforms: string[],
  variationCount: number,
): Promise<TextGenerationResult> {
  const isGroq = provider === "Groq";
  const key = isGroq ? GROQ_API_KEY : OLLAMA_API_KEY;
  if (!key) throw new Error(provider + " is not configured.");
  const url = isGroq ? "https://api.groq.com/openai/v1/chat/completions" : "https://ollama.com/api/chat";
  const model = isGroq ? GROQ_MODEL : OLLAMA_MODEL;
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
      ...(isGroq
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
  const raw = isGroq ? data?.choices?.[0]?.message?.content : data?.message?.content;
  const outputs = parseOutputs(typeof raw === "string" ? raw : "", platforms, variationCount);
  if (!outputs) throw new Error(provider + " returned an invalid draft format.");
  const usage = isGroq ? data?.usage || {} : {};
  const inputTokens = isGroq ? usage.prompt_tokens : data?.prompt_eval_count;
  const outputTokens = isGroq ? usage.completion_tokens : data?.eval_count;
  return {
    outputs,
    model,
    inputTokens: Number.isInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isInteger(outputTokens) ? outputTokens : null,
  };
}

async function generateText(prompt: string, platforms: string[], variationCount: number) {
  try {
    return { ...await geminiText(prompt, platforms, variationCount), provider: "Gemini", fallbackUsed: false };
  } catch (primaryError) {
    if (!shouldFallback(primaryError)) throw primaryError;
    console.warn("Gemini generation failed; trying configured fallback providers.");
  }

  const fallbacks: Array<{ name: "Groq" | "Ollama"; ready: boolean }> = [
    { name: "Groq", ready: !!GROQ_API_KEY },
    { name: "Ollama", ready: !!OLLAMA_API_KEY },
  ];
  for (const fallback of fallbacks) {
    if (!fallback.ready) continue;
    try {
      return {
        ...await compatibleText(fallback.name, prompt, platforms, variationCount),
        provider: fallback.name,
        fallbackUsed: true,
      };
    } catch (error) {
      console.error(fallback.name + " fallback failed", safeErrorStatus(error));
    }
  }
  throw new Error("AI providers are temporarily unavailable. Please try again shortly.");
}

function supportsAgenticVideo(model: string): boolean {
  return /^gemini-(?:3\.5-flash-lite|3\.[6-8]-flash)(?:-|$)/i.test(model);
}

async function generateYouTube(
  url: string,
  title: string,
  platforms: string[],
  preferences: GenerationPreferences,
  variationCount: number,
): Promise<TextGenerationResult> {
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
  const prompt = [
    "Repurpose this public YouTube video into platform-native drafts.",
    "Use the spoken content and relevant visuals. Preserve the meaning; do not invent facts or quotes.",
    "Writing preferences: " + JSON.stringify(preferences),
    outputShape,
    "Video title: " + JSON.stringify(title.slice(0, 300)),
    "Requested formats:\n" + instructions,
  ].join("\n\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    signal: AbortSignal.timeout(55000),
    body: JSON.stringify({
      model: GEMINI_MODEL,
      system_instruction: GENERATION_SYSTEM_INSTRUCTION,
      input: [
        { type: "video", uri: url, processing: supportsAgenticVideo(GEMINI_MODEL) ? "agentic" : "static" },
        { type: "text", text: prompt },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: schemaFor(platforms, variationCount),
      },
      generation_config: { max_output_tokens: 6000 },
      store: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Could not analyze this YouTube video.");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  if (data?.status && data.status !== "completed") {
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
  const outputs = parseOutputs(raw, platforms, variationCount);
  if (!outputs) throw new Error("Gemini returned an invalid video draft format.");
  const usage = data?.usage || {};
  return {
    outputs,
    model: typeof data.model === "string" ? data.model : GEMINI_MODEL,
    inputTokens: Number.isInteger(usage.total_input_tokens) ? usage.total_input_tokens : null,
    outputTokens: Number.isInteger(usage.total_output_tokens) ? usage.total_output_tokens : null,
  };
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return reply({ error: "Request body is too large." }, 413);
  }

  const userId = await authenticate(req);
  if (!userId) return reply({ error: "Sign in to HookEngine to use your allowance." }, 401);
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
  if (!Number.isInteger(variationCount) || variationCount < 1 || variationCount > 3 ||
      !Array.isArray(reservation.allowed_platforms) ||
      !payload.platforms.every((platform) => reservation.allowed_platforms.includes(platform))) {
    console.error("Reservation returned invalid entitlement metadata.");
    try {
      await finish(userId, reservation.generation_id, "failed", {}, [], null, null, null, null, 0,
        "Invalid entitlement metadata.");
    } catch (error) {
      console.error("Could not refund invalid entitlement reservation.", safeErrorStatus(error));
    }
    return reply({ error: "Your plan settings could not be verified. Please contact support." }, 503);
  }

  const startedAt = performance.now();
  try {
    const result = payload.sourceMode === "youtube_video"
      ? { ...await generateYouTube(payload.sourceUrl, payload.title, payload.platforms, payload.preferences, variationCount), provider: "Gemini", fallbackUsed: false }
      : await generateText(
        promptFor(payload.title, payload.text.trim(), payload.platforms, payload.preferences, variationCount),
        payload.platforms,
        variationCount,
      );
    const latencyMs = Math.round(performance.now() - startedAt);
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
    );
    return reply({
      outputs: result.outputs,
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
    console.error("HookEngine generation failed.", safeErrorStatus(error));
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
    return reply({ error: "HookEngine could not process this request. Please try again." }, 503);
  }
});

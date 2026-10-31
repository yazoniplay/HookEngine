import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?\} from "\.\/extension\/config\.js";\s*/, "");
const storage = new Map();
const context = {
  URL,
  console,
  SUPABASE_URL: "https://project.example",
  SUPABASE_KEY: "public-anon-key",
  FUNCTION_URL: "https://project.example/functions/v1/hookengine-generate",
  STORAGE_KEYS: {
    session: "hookengine-account-session",
    lastGeneration: "hookengine-last-generation"
  },
  MAX_SOURCE_CHARS: 60000,
  MIN_SOURCE_CHARS: 80
};
context.chrome = {
  runtime: {
    id: "hookengine-test",
    onMessage: { addListener(listener) { context.messageListener = listener; } }
  },
  storage: {
    local: {
      async get(key) { return { [key]: storage.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
      async remove(key) { storage.delete(key); }
    }
  },
  tabs: { async query() { return []; } },
  scripting: { async executeScript() { return [{ result: null }]; } }
};
context.fetch = async () => { throw new Error("Unexpected fetch in test"); };
vm.runInNewContext(source, context, { filename: "background.js" });

test("decodes common caption entities", () => {
  assert.equal(context.decodeCaptionText("A &amp; B &lt;tag&gt; &#39;ok&#39;"), "A & B <tag> 'ok'");
});

test("invalid numeric entities do not throw or crash caption parsing", () => {
  assert.equal(context.decodeCaptionText("before &#999999999999; after"), "before after");
  assert.equal(context.decodeCaptionText("before &#xZZZZ; after"), "before &#xZZZZ; after");
});

test("parses YouTube JSON3 caption events", () => {
  const payload = JSON.stringify({
    events: [
      { segs: [{ utf8: "A transcript line with enough text " }] },
      { segs: [{ utf8: "and a second segment for validation." }] }
    ]
  });
  assert.match(context.parseCaptionPayload(payload), /second segment/);
});

test("parses WebVTT while removing timestamps and cue indexes", () => {
  const payload = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nA sufficiently long caption line.\n\n2\n00:00:03.000 --> 00:00:05.000\nAnother sufficiently long caption line.";
  const parsed = context.parseCaptionPayload(payload);
  assert.match(parsed, /A sufficiently long caption line/);
  assert.match(parsed, /Another sufficiently long caption line/);
  assert.doesNotMatch(parsed, /00:00:01/);
});

test("parses XML caption tracks", () => {
  const payload = '<transcript><text start="0">This is a sufficiently long transcript segment.</text><text start="2">This is another sufficiently long segment.</text></transcript>';
  assert.match(context.parseCaptionPayload(payload), /another sufficiently long segment/);
});

test("extracts the embedded YouTube player response without greedy parsing", () => {
  const expected = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } }, videoDetails: { title: "Demo" } };
  const html = "prefix ytInitialPlayerResponse = " + JSON.stringify(expected) + "; suffix";
  assert.deepEqual(JSON.parse(JSON.stringify(context.extractPlayerResponse(html))), expected);
});

test("accepts only HTTPS YouTube timed-text caption URLs", () => {
  assert.match(context.normalizeCaptionUrl("https://www.youtube.com/api/timedtext?v=abc"), /^https:\/\/www\.youtube\.com\/api\/timedtext/);
  assert.equal(context.normalizeCaptionUrl("http://www.youtube.com/api/timedtext?v=abc"), "");
  assert.equal(context.normalizeCaptionUrl("https://attacker.example/api/timedtext?v=abc"), "");
  assert.equal(context.normalizeCaptionUrl("https://www.youtube.com/watch?v=abc"), "");
});

test("the background worker injects Readability before the content extractor", async () => {
  const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(background, /files:\s*\["vendor\/readability\.js",\s*"content\.js"\]/);
});

test("the article extractor prefers Readability and keeps a local fallback", async () => {
  const extractor = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(extractor, /new Readability\(document\.cloneNode\(true\)/);
  assert.match(extractor, /function articleText\(\)/);
  assert.match(extractor, /const readable = readabilityArticleText\(\)/);
  assert.match(extractor, /const candidates = new Set\(\)/);
});

test("YouTube transcript parsing has one owner in the background worker", async () => {
  const extractor = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.doesNotMatch(extractor, /function youtubeTranscript\(/);
  assert.doesNotMatch(extractor, /function findEmbeddedCaptionTrack\(/);
  assert.match(extractor, /const transcript = isYouTube \? "" : nativeVideoTranscript\(\)/);
});

test("the vendored Readability dependency is pinned and attributed", async () => {
  const vendor = await readFile(new URL("../vendor/readability.js", import.meta.url), "utf8");
  const license = await readFile(new URL("../vendor/READABILITY-LICENSE.md", import.meta.url), "utf8");
  const notice = await readFile(new URL("../vendor/READABILITY-NOTICE", import.meta.url), "utf8");
  assert.match(vendor, /ab4027a8b37669745016869a37a504727992b2ba/);
  assert.match(vendor, /function Readability\(/);
  assert.match(license, /Apache License/);
  assert.ok(notice.trim().length > 0);
});

test("the toolbar popup remains a Manifest V3 action popup", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.7.0");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.background.type, "module");
});

test("the settings page loads the shared-storage module", async () => {
  const html = await readFile(new URL("../settings.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../settings.js", import.meta.url), "utf8");
  assert.match(html, /<script type="module" src="settings\.js"><\/script>/);
  assert.match(script, /import \{ STORAGE_KEYS \} from "\.\/extension\/config\.js"/);
});

test("the public Supabase client key lives in shared extension config", async () => {
  const config = await readFile(new URL("../extension/config.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  const match = config.match(/SUPABASE_KEY = "([^"]+)"/);
  assert.ok(match, "shared config should define the public client key");
  const payload = JSON.parse(Buffer.from(match[1].split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.role, "anon", "the browser key must be the public anon role");
  assert.match(popup, /SUPABASE_KEY/);
  assert.match(popup, /from "\.\/extension\/config\.js"/);
  assert.doesNotMatch(popup, /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\./);
});

test("both extension HTML entry points load the popup application as a module", async () => {
  const popup = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const sidepanel = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
  assert.match(popup, /<script type="module" src="sidepanel\.js"><\/script>/);
  assert.match(sidepanel, /<script type="module" src="sidepanel\.js"><\/script>/);
});

test("transient session verification failures preserve the saved login", async () => {
  const auth = await readFile(new URL("../extension/auth.js", import.meta.url), "utf8");
  assert.match(auth, /session is preserved/);
  assert.match(auth, /session has been kept/);
  assert.match(auth, /writeStoredSession\(null\)/);
});

test("the account sign-in buttons use their own form fields and messages", async () => {
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(popup, /signIn\("account"\)/);
  assert.match(popup, /signIn\("gate"\)/);
  assert.match(popup, /accountMessage/);
  assert.match(popup, /gateMessage/);
});

test("the popup delegates session management to the dedicated auth module", async () => {
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  const auth = await readFile(new URL("../extension/auth.js", import.meta.url), "utf8");
  assert.match(popup, /from "\.\/extension\/auth\.js"/);
  assert.match(popup, /restoreSession/);
  assert.match(popup, /authenticate\(email, password\)/);
  assert.match(auth, /export async function restoreSession\(\)/);
  assert.match(auth, /export async function signIn\(email, password\)/);
  assert.match(auth, /export async function signOut\(\)/);
});

test("YouTube extraction does not run the article parser as a fallback", async () => {
  const extractor = await readFile(new URL("../content.js", import.meta.url), "utf8");
  assert.match(extractor, /const text = isYouTube \? selection : \(transcript \|\| selection \|\| articleText\(\)\)/);
});

test("manual source fields enforce the shared maximum length", async () => {
  const popup = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const sidepanel = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(popup, /id="sourceText"[^>]*maxlength="60000"/);
  assert.match(sidepanel, /id="sourceText"[^>]*maxlength="60000"/);
  assert.match(script, /length > MAX_SOURCE_CHARS/);
  assert.match(script, /length < MIN_SOURCE_CHARS/);
});

test("fallback page cleanup preserves the letter t and normalizes whitespace", async () => {
  const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.ok(background.includes(String.raw`.replace(/\u200b/g, "")`));
  assert.ok(background.includes(String.raw`.replace(/[ \t]+/g, " ")`));
  assert.ok(background.includes(String.raw`.replace(/\n{3,}/g, "\n\n")`));

  const normalize = new Function("value", String.raw`return (value || "")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();`);
  assert.equal(normalize("content text"), "content text");
  assert.equal(normalize("con\tent"), "con ent");
  assert.equal(normalize("a\u200bb"), "ab");
  assert.equal(normalize("first\n\n\nsecond"), "first\n\nsecond");
});


test("YouTube video IDs are validated against supported hosts and formats", () => {
  assert.equal(context.getYouTubeVideoId("https://www.youtube.com/watch?v=abcdefghijk"), "abcdefghijk");
  assert.equal(context.getYouTubeVideoId("https://youtu.be/abcdefghijk"), "abcdefghijk");
  assert.equal(context.getYouTubeVideoId("https://attacker.example/watch?v=abcdefghijk"), "");
  assert.equal(context.getYouTubeVideoId("https://www.youtube.com/watch?v=short"), "");
});

test("YouTube generation uses a transcript before the Gemini video fallback", async () => {
  context.chrome.tabs.query = async () => [{
    id: 7,
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    title: "Video title"
  }];
  context.getPageCaptionTracks = async () => ({ title: "Video title", captionTracks: [] });
  context.fetchCaptionTracks = async () => "A transcript with more than eighty characters. ".repeat(3);
  context.fetchYouTubeTranscript = async () => "";
  const source = {
    sourceMode: "youtube_video",
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    title: "Video title",
    platforms: ["x_thread"]
  };
  const transcript = await context.resolveYouTubeGenerationSource(source);
  assert.equal(transcript.transcriptUsed, true);
  assert.equal(transcript.payload.sourceMode, "text");
  assert.ok(transcript.payload.text.length >= 80);

  context.fetchCaptionTracks = async () => "";
  const fallback = await context.resolveYouTubeGenerationSource(source);
  assert.equal(fallback.transcriptUsed, false);
  assert.equal(fallback.payload.sourceMode, "youtube_video");
});

test("service-worker generation refreshes an expired token exactly once", async () => {
  storage.set("hookengine-account-session", {
    access_token: "expired-access",
    refresh_token: "refresh-token"
  });
  let generationCalls = 0;
  let refreshCalls = 0;
  context.fetch = async (url, options) => {
    if (url === context.FUNCTION_URL) {
      generationCalls++;
      if (generationCalls === 1) return {
        ok: false, status: 401, async json() { return { error: "expired" }; }
      };
      return {
        ok: true, status: 200,
        async json() { return { outputs: { x_thread: "Draft" }, usage: { plan: "free" } }; }
      };
    }
    if (String(url).includes("grant_type=refresh_token")) {
      refreshCalls++;
      return {
        ok: true, status: 200,
        async json() { return { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }; }
      };
    }
    throw new Error("Unexpected URL " + url);
  };

  const data = await context.generateWithStoredSession({ text: "source" });
  assert.equal(data.outputs.x_thread, "Draft");
  assert.equal(generationCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(storage.get("hookengine-account-session").access_token, "fresh-access");
});

test("service-worker generation persists the last result without storing source text", async () => {
  storage.set("hookengine-account-session", {
    access_token: "valid-access",
    refresh_token: "refresh-token"
  });
  context.fetch = async url => {
    assert.equal(url, context.FUNCTION_URL);
    return {
      ok: true, status: 200,
      async json() {
        return {
          outputs: { x_thread: ["Version one", "Version two"] },
          provider: "Gemini",
          usage: { plan: "free", remaining: 2 }
        };
      }
    };
  };
  const result = await context.handleGenerationMessage({
    payload: {
      text: "A source article long enough to pass validation. ".repeat(3),
      title: "Source title",
      sourceUrl: "https://example.com/article",
      sourceMode: "text",
      platforms: ["x_thread"]
    }
  });
  const saved = storage.get("hookengine-last-generation");
  assert.equal(result.ok, true);
  assert.equal(saved.outputs.x_thread.length, 2);
  assert.equal(saved.usage.remaining, 2);
  assert.equal(saved.sourceUrl, "https://example.com/article");
  assert.equal("sourceText" in saved, false);
  assert.equal("text" in saved, false);
});


test("the popup can restore a persisted result after reopening", async () => {
  const saved = {
    outputs: { x_thread: ["Version one", "Version two"] },
    usage: { plan: "free", remaining: 2 },
    provider: "Gemini"
  };
  storage.set("hookengine-last-generation", saved);
  const response = await new Promise(resolve => {
    context.messageListener(
      { type: "HOOKENGINE_GET_LAST_GENERATION" },
      { id: "hookengine-test" },
      resolve
    );
  });
  assert.equal(response.ok, true);
  assert.equal(response.lastGeneration.outputs.x_thread.length, 2);
  assert.equal(response.lastGeneration.usage.remaining, 2);
});

test("the popup can clear its persisted result", async () => {
  storage.set("hookengine-last-generation", { outputs: { x_thread: "draft" } });
  const response = await new Promise(resolve => {
    context.messageListener(
      { type: "HOOKENGINE_CLEAR_LAST_GENERATION" },
      { id: "hookengine-test" },
      resolve
    );
  });
  assert.equal(response.ok, true);
  assert.equal(storage.has("hookengine-last-generation"), false);
});

test("a second generation 401 does not trigger another refresh attempt", async () => {
  storage.set("hookengine-account-session", {
    access_token: "expired-access",
    refresh_token: "refresh-token"
  });
  let generationCalls = 0;
  let refreshCalls = 0;
  context.fetch = async url => {
    if (url === context.FUNCTION_URL) {
      generationCalls++;
      return { ok: false, status: 401, async json() { return { error: "unauthorized" }; } };
    }
    if (String(url).includes("grant_type=refresh_token")) {
      refreshCalls++;
      return {
        ok: true, status: 200,
        async json() { return { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }; }
      };
    }
    throw new Error("Unexpected URL " + url);
  };
  await assert.rejects(
    context.generateWithStoredSession({ text: "source" }),
    /Your session expired/
  );
  assert.equal(generationCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(storage.has("hookengine-account-session"), false);
});

test("draft output renderer accepts array versions and exposes result actions", async () => {
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  assert.match(popup, /Array\.isArray\(value\)/);
  assert.match(popup, /threadParts/);
  assert.match(popup, /copyAllBtn/);
  assert.match(popup, /clearResultsBtn/);
  assert.match(html, /id="copyAllBtn"/);
  assert.match(html, /id="clearResultsBtn"/);
});


test("manifest declares the 1.7.0 toolbar popup, settings page and native-size icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, "1.7.0");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.options_page, "settings.html");
  assert.equal(manifest.action.default_icon["16"], "icons/icon16.png");
  assert.equal(manifest.action.default_icon["32"], "icons/icon32.png");
  assert.equal(manifest.icons["48"], "icons/icon48.png");
  assert.equal(manifest.icons["128"], "icons/icon128.png");
  assert.equal(manifest.background.type, "module");
});

test("writing preferences are saved in sync storage and sent with generation requests", async () => {
  const settings = await readFile(new URL("../settings.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../settings.html", import.meta.url), "utf8");
  assert.match(settings, /chrome\.storage\.sync\.get/);
  assert.match(settings, /chrome\.storage\.sync\.set/);
  for (const field of ["tone", "style", "length", "audience"]) {
    assert.match(html, new RegExp('id="' + field + '"'));
    assert.match(settings, new RegExp('"' + field + '"'));
  }
  assert.match(popup, /preferences:\(await chrome\.storage\.sync\.get\(WRITING_PREFS_KEY\)\)/);
  assert.match(popup, /openOptionsPage/);
});

test("account toggle remains a real button and switches the account panel", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(html, /<button id="accountToggle"[^>]*aria-controls="accountPanel"[^>]*aria-expanded="false"/);
  assert.match(popup, /panel\.hidden = !panel\.hidden/);
  assert.match(popup, /setAttribute\("aria-expanded", String\(!panel\.hidden\)\)/);
  assert.doesNotMatch(popup, /accountToggle"\)\.addEventListener\("keydown"/);
});

test("the popup includes an account history link and the last generation is restored", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(html, /Account & history/);
  assert.match(popup, /restoreLastGeneration\(\)/);
  assert.match(popup, /HOOKENGINE_GET_LAST_GENERATION/);
});


test("worker messages require the extension sender identity", async () => {
  const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(background, /sender\?\.id !== chrome\.runtime\.id/);
});

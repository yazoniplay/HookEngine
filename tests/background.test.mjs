import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const context = {
  URL,
  console,
  chrome: { runtime: { onMessage: { addListener() {} } } }
};
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
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(popup, /saved session is preserved/);
  assert.match(popup, /session has been kept/);
  assert.match(popup, /clearStoredAccountSession/);
});

test("the account sign-in buttons use their own form fields and messages", async () => {
  const popup = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
  assert.match(popup, /signIn\("account"\)/);
  assert.match(popup, /signIn\("gate"\)/);
  assert.match(popup, /accountMessage/);
  assert.match(popup, /gateMessage/);
});

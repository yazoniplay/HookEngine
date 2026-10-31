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

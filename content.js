(() => {
  if (window.__hookEngineContentLoaded) return;
  window.__hookEngineContentLoaded = true;

  const clean = value => (value || "")
    .replace(/\\u200b/g, "")
    .replace(/[ \\t]+/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

  function decodeText(value) {
    const box = document.createElement("textarea");
    box.innerHTML = value || "";
    return box.value;
  }

  function findEmbeddedCaptionTrack() {
    const sources = [...document.scripts].map(s => s.textContent || "").concat(document.documentElement?.innerHTML || "");
    for (const source of sources) {
      let offset = 0;
      while ((offset = source.indexOf("ytInitialPlayerResponse", offset)) !== -1) {
        const start = source.indexOf("{", offset + "ytInitialPlayerResponse".length);
        if (start < 0 || start - offset > 120) { offset += 24; continue; }
        let depth = 0, inString = false, escaped = false;
        for (let i = start; i < source.length; i++) {
          const ch = source[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\\\") escaped = true;
            else if (ch === '"') inString = false;
          } else if (ch === '"') inString = true;
          else if (ch === "{") depth++;
          else if (ch === "}") {
            if (--depth === 0) {
              try {
                const data = JSON.parse(source.slice(start, i + 1));
                const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                const track = tracks.find(t => /^en(-|$)/i.test(t.languageCode || "")) || tracks[0];
                if (track?.baseUrl) return track.baseUrl;
              } catch {}
              break;
            }
          }
        }
        offset += 24;
      }
    }
    return "";
  }

  function youtubeTranscript() {
    const selectors = [
      "ytd-transcript-renderer #segments-container",
      "ytd-transcript-renderer .segment-text",
      "ytd-transcript-segment-renderer .segment-text",
      "[data-purpose='transcript-segment']"
    ];
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const text = clean(nodes.map(node => node.innerText || node.textContent).join(" "));
      if (text.length > 120) return text;
    }
    return "";
  }

  const NOISE = [
    "script","style","noscript","nav","header","footer","aside","form","button","input","select","textarea",
    "iframe","svg","[aria-hidden='true']","[role='navigation']","[role='banner']","[role='dialog']",
    "[aria-modal='true']","[class*='cookie' i]","[id*='cookie' i]","[class*='consent' i]",
    "[id*='consent' i]","[class*='advert' i]","[id*='advert' i]","[class*='promo' i]",
    "[class*='related' i]","[class*='recommend' i]","[class*='newsletter' i]","[class*='share' i]",
    "[class*='social' i]","[class*='comment' i]","[id*='comment' i]"
  ].join(",");

  function cleanedClone(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(NOISE).forEach(node => node.remove());
    return clone;
  }

  function blockText(root) {
    return [...root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dd,dt,[data-testid*='paragraph' i]") ]
      .map(node => clean(node.innerText || node.textContent))
      .filter(value => value.length >= 30 &&
        !/^(share|read more|sign in|subscribe|advertisement|related articles?|cookie settings)\\b/i.test(value));
  }

  function articleText() {
    const selectors = [
      "article","main","[role='main']","[itemprop='articleBody']","[itemprop='text']",
      "[class*='article-body' i]","[class*='article-content' i]","[class*='story-body' i]",
      "[class*='storyBody' i]","[class*='post-content' i]","[class*='entry-content' i]",
      "[class*='rich-text' i]","[class*='prose' i]","[class*='article__body' i]",
      "[data-component='text-block']","[data-testid*='article' i]","[data-testid*='story' i]",
      "[data-testid*='content' i]","[data-testid*='paragraph' i]","#content","#main-content",
      ".markdown-body",".documentation",".StoryBodyCompanionColumn",".meteredContent"
    ];
    const candidates = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        const rects = el.getClientRects();
        const style = getComputedStyle(el);
        if (rects.length && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") candidates.add(el);
      });
    }

    // Capture rich containers even when the publisher uses undocumented class names.
    for (const el of [...document.querySelectorAll("div,section")].slice(0, 2200)) {
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || style.display === "none" || style.visibility === "hidden") continue;
      const paragraphs = el.querySelectorAll("p,li,blockquote").length;
      if (paragraphs >= 2) candidates.add(el);
    }

    let best = "";
    let bestScore = -1;
    for (const original of candidates) {
      const clone = cleanedClone(original);
      const blocks = blockText(clone);
      const text = clean(blocks.join("\\n\\n") || clone.innerText || clone.textContent);
      if (text.length < 80) continue;
      const longBlocks = blocks.filter(block => block.length >= 60).length;
      const links = [...clone.querySelectorAll("a")].reduce((n, a) => n + clean(a.innerText || a.textContent).length, 0);
      const density = links / Math.max(1, text.length);
      const hint = [
        original.getAttribute("itemprop"), original.getAttribute("role"), original.id,
        typeof original.className === "string" ? original.className : "",
        original.getAttribute("data-testid"), original.getAttribute("data-component")
      ].join(" ").toLowerCase();
      const positive = /article|content|story|post|entry|main|body|prose|reader|document|transcript|paragraph/.test(hint) ? 240 : 0;
      const negative = /nav|menu|footer|header|sidebar|comment|recommend|related|share|advert|cookie|promo/.test(hint) ? 500 : 0;
      const score = Math.min(text.length, 22000) + longBlocks * 110 + positive - negative - Math.min(1, density) * 900;
      if (score > bestScore) { bestScore = score; best = text; }
    }
    if (best.length >= 120) return best;

    // Fallback for sites that render readable content without semantic article markup.
    const body = document.body;
    if (!body) return best;
    const bodyClone = cleanedClone(body);
    const fallback = blockText(bodyClone).join("\\n\\n");
    if (fallback.length > best.length) best = clean(fallback);

    // Last resort: use readable body text after removing obvious site chrome.
    if (best.length < 120) {
      const raw = clean(bodyClone.innerText || bodyClone.textContent);
      const lines = raw.split("\\n").map(clean).filter(line => line.length >= 35 &&
        !/^(home|menu|search|sign in|log in|subscribe|accept all|privacy policy|terms of use|share|read more)$/i.test(line));
      const fallbackText = clean(lines.join("\\n\\n"));
      if (fallbackText.length > best.length) best = fallbackText;
    }
    return best;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "HOOKENGINE_EXTRACT") return;
    const isYouTube = /(^|\\.)youtube\\.com$|(^|\\.)youtu\\.be$/i.test(location.hostname);
    const transcript = isYouTube ? youtubeTranscript() : "";
    const text = transcript || articleText();
    const usable = text.length >= 80;
    sendResponse({
      text: usable ? text.slice(0, 60000) : "",
      title: document.title || "",
      url: location.href,
      sourceType: transcript ? "youtube-transcript" : (isYouTube ? "youtube-page" : "article"),
      needsTranscript: isYouTube && !transcript,
      captionTrackUrl: isYouTube && !transcript ? findEmbeddedCaptionTrack() : "",
      extractionFailed: !usable
    });
  });
})();

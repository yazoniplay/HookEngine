(() => {
  if (window.__hookEngineContentLoaded) return;
  window.__hookEngineContentLoaded = true;

  const clean = (value) => (value || "")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function youtubeCaptionTrackUrl() {
    // YouTube embeds the player response in the page HTML even when its transcript
    // panel is closed. Read the caption track metadata without scraping page chrome.
    const html = document.documentElement?.innerHTML || "";
    const markers = ["ytInitialPlayerResponse", "playerResponse"];
    for (const marker of markers) {
      let from = 0;
      while ((from = html.indexOf(marker, from)) !== -1) {
        const start = html.indexOf("{", from + marker.length);
        if (start < 0 || start - from > 120) { from += marker.length; continue; }
        let depth = 0, inString = false, escaped = false;
        for (let i = start; i < html.length; i++) {
          const ch = html[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\\\") escaped = true;
            else if (ch === '"') inString = false;
          } else if (ch === '"') inString = true;
          else if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              try {
                const player = JSON.parse(html.slice(start, i + 1));
                const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                const track = tracks.find(t => /^en(-|$)/i.test(t.languageCode || "")) || tracks[0];
                if (track?.baseUrl) return track.baseUrl;
              } catch {}
              break;
            }
          }
        }
        from += marker.length;
      }
    }
    return "";
  }

  function findEmbeddedCaptionTrack() {
    const scripts = [...document.scripts].map(s => s.textContent || "").filter(Boolean);
    const sources = scripts.concat(document.documentElement?.innerHTML || "");
    for (const source of sources) {
      const marker = "ytInitialPlayerResponse";
      let offset = 0;
      while ((offset = source.indexOf(marker, offset)) !== -1) {
        const start = source.indexOf("{", offset + marker.length);
        if (start < 0 || start - offset > 100) { offset += marker.length; continue; }
        let depth = 0, inString = false, escaped = false;
        for (let i = start; i < source.length; i++) {
          const ch = source[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
          } else if (ch === '"') inString = true;
          else if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
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
        offset += marker.length;
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
      const text = clean(nodes.map(node => node.innerText || node.textContent).join("\n"));
      if (text.length > 120) return text;
    }
    return "";
  }

  function removeNoise(root) {
    root.querySelectorAll([
      "script", "style", "noscript", "nav", "header", "footer", "aside", "form",
      "button", "[aria-hidden='true']", "[role='navigation']", "[role='banner']",
      "[role='dialog']", "[aria-modal='true']", "iframe", "svg",
      "[id*='cookie' i]", "[class*='cookie' i]", "[id*='consent' i]",
      "[class*='consent' i]", "[class*='advert' i]", "[class*='promo' i]",
      "[class*='related' i]", "[class*='newsletter' i]"
    ].join(",")).forEach(el => el.remove());
    return root;
  }

  function articleText() {
    // Best-effort extraction for news sites, blogs, documentation, forums and
    // web apps. Score candidate containers by meaningful text, paragraph density,
    // semantic hints and boilerplate signals instead of stopping at the first root.
    const noiseSelector = [
      "script","style","noscript","nav","header","footer","aside","form","button",
      "input","select","textarea","[aria-hidden='true']","[role='navigation']",
      "[role='banner']","[role='dialog']","[aria-modal='true']","iframe","svg",
      "[class*='cookie' i]","[id*='cookie' i]","[class*='consent' i]","[id*='consent' i]",
      "[class*='advert' i]","[id*='advert' i]","[class*='promo' i]","[class*='related' i]",
      "[class*='recommend' i]","[class*='newsletter' i]","[class*='share' i]",
      "[class*='social' i]","[class*='comment' i]","[id*='comment' i]"
    ].join(",");
    const isVisible = el => {
      if (!el || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const extractBlocks = root => [...root.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dd,dt")]
      .map(el => clean(el.innerText || el.textContent))
      .filter(text => text.length >= 35 && !/^(share|read more|sign in|subscribe|advertisement|related articles?)\b/i.test(text));
    const candidates = new Set();
    const selectors = [
      "article","main","[role='main']","[itemprop='articleBody']","[class*='article-body' i]",
      "[class*='article-content' i]","[class*='story-body' i]","[class*='post-content' i]",
      "[class*='entry-content' i]","[class*='rich-text' i]","[class*='prose' i]",
      "[data-component='text-block']","[data-testid*='article' i]","[data-testid*='content' i]",
      "#content","#main-content",".markdown-body",".documentation"
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => { if (isVisible(el)) candidates.add(el); });
    }
    // Include content-rich divs. Limit the scan to avoid doing expensive work on
    // every element on large web apps.
    [...document.querySelectorAll("div,section")].slice(0, 1800).forEach(el => {
      if (!isVisible(el)) return;
      const text = clean(el.innerText || "");
      if (text.length >= 250 && el.querySelectorAll("p,li,blockquote").length >= 2) candidates.add(el);
    });

    let bestText = "";
    let bestScore = -Infinity;
    for (const original of candidates) {
      const clone = removeNoise(original.cloneNode(true));
      const blocks = extractBlocks(clone);
      const text = clean(blocks.join("\n\n") || clone.innerText || clone.textContent);
      if (text.length < 80) continue;
      const paragraphCount = blocks.filter(t => t.length >= 60).length;
      const linkText = [...clone.querySelectorAll("a")].map(a => clean(a.innerText || a.textContent)).join(" ").length;
      const linkDensity = Math.min(1, linkText / Math.max(1, text.length));
      const hint = ((original.getAttribute("itemprop") || "") + " " +
        (original.getAttribute("role") || "") + " " +
        (original.id || "") + " " + (typeof original.className === "string" ? original.className : "")).toLowerCase();
      const positive = /article|content|story|post|entry|main|body|prose|reader|document|transcript/.test(hint) ? 180 : 0;
      const negative = /nav|menu|footer|header|sidebar|comment|recommend|related|share|advert|cookie|promo/.test(hint) ? 260 : 0;
      const score = Math.min(text.length, 18000) + paragraphCount * 90 + positive - negative - linkDensity * 700;
      if (score > bestScore) { bestScore = score; bestText = text; }
    }

    if (bestText.length >= 120) return bestText;

    // Fallback: keep visible text blocks from the page, skipping common UI labels.
    const fallback = extractBlocks(document.body)
      .filter(text => !/^(home|menu|search|sign in|log in|subscribe|accept all|privacy policy|terms of use)$/i.test(text));
    const fallbackText = clean(fallback.join("\n\n"));
    if (fallbackText.length >= bestText.length) bestText = fallbackText;

    // Some web apps render text in custom elements or unusual containers.
    if (bestText.length < 120 && document.body) {
      const clone = removeNoise(document.body.cloneNode(true));
      const bodyText = clean(clone.innerText || clone.textContent);
      if (bodyText.length > bestText.length) bestText = bodyText;
    }
    return bestText;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "HOOKENGINE_EXTRACT") return;
    const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(location.hostname);
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
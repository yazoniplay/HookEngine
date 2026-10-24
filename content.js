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
    // BBC pages can render the story inside a nested article/content block rather
    // than the first generic <main>, so test likely article roots individually.
    const selectors = [
      "article [data-component='text-block']",
      "[data-component='text-block']",
      "article",
      "main",
      "[role='main']",
      "[itemprop='articleBody']",
      ".article-body",
      ".story-body"
    ];

    let best = "";
    for (const selector of selectors) {
      const roots = [...document.querySelectorAll(selector)];
      for (const original of roots) {
        const clone = removeNoise(original.cloneNode(true));
        const parts = [...clone.querySelectorAll("h1,h2,h3,p,li,blockquote,pre")]
          .map(el => el.innerText || el.textContent)
          .map(clean)
          .filter(text => text.length > 25);
        const candidate = clean(parts.join("\n\n") || clone.innerText || clone.textContent);
        if (candidate.length > best.length) best = candidate;
      }
      if (best.length >= 250) break;
    }

    // Fallback for sites whose article text is not wrapped in semantic tags.
    if (best.length < 120) {
      const clone = removeNoise(document.body.cloneNode(true));
      const bodyText = clean(clone.innerText || clone.textContent);
      if (bodyText.length > best.length) best = bodyText;
    }

    // If the page uses paragraphs outside a normal article wrapper, use the
    // visible page paragraphs but skip short navigation fragments.
    if (best.length < 120) {
      const paragraphs = [...document.querySelectorAll("p")]
        .filter(el => el.getClientRects().length)
        .map(el => clean(el.innerText || el.textContent))
        .filter(text => text.length > 25);
      const fallback = clean(paragraphs.join("\n\n"));
      if (fallback.length > best.length) best = fallback;
    }

    return best;
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
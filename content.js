(() => {
  if (window.__hookEngineContentLoaded) return;
  window.__hookEngineContentLoaded = true;

  const clean = value => (value || "")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function decodeText(value) {
    const box = document.createElement("textarea");
    box.innerHTML = value || "";
    return box.value;
  }

  function nativeVideoTranscript() {
    const pieces = [];
    for (const video of document.querySelectorAll("video")) {
      try {
        for (const track of video.textTracks || []) {
          if (track.kind !== "captions" && track.kind !== "subtitles" && track.kind !== "descriptions") continue;
          try { track.mode = "hidden"; } catch {}
          for (const cue of track.cues || []) {
            const value = clean(cue.text || "");
            if (value) pieces.push(value);
          }
        }
      } catch {}
    }
    const unique = [...new Set(pieces)];
    return clean(unique.join(" ")).slice(0, 60000);
  }

  function selectedText() {
    return clean(window.getSelection ? window.getSelection().toString() : "");
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
        !/^(share|read more|sign in|subscribe|advertisement|related articles?|cookie settings)\b/i.test(value));
  }

  function structuredArticleText() {
    const found = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = script.textContent || "";
      if (!raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw);
        const visit = value => {
          if (!value) return;
          if (Array.isArray(value)) return value.forEach(visit);
          if (typeof value !== "object") return;
          const type = value["@type"];
          const types = Array.isArray(type) ? type : [type];
          if (types.some(t => /article|newsarticle|reportage|blogposting/i.test(String(t))) &&
              typeof value.articleBody === "string" && value.articleBody.trim().length > 80) {
            found.push(value.articleBody.trim());
          }
          for (const [key, child] of Object.entries(value)) {
            if (key !== "articleBody") visit(child);
          }
        };
        visit(parsed);
      } catch {}
    }
    return found.sort((a, b) => b.length - a.length)[0] || "";
  }

  function readabilityArticleText() {
    if (typeof Readability !== "function") return "";
    try {
      const parsed = new Readability(document.cloneNode(true), {
        charThreshold: 120,
        maxElemsToParse: 25000,
        keepClasses: false
      }).parse();
      return clean(parsed?.textContent || "");
    } catch (error) {
      console.warn("HookEngine: Readability extraction failed; using the fallback extractor", error);
      return "";
    }
  }

  function articleText() {
    const readable = readabilityArticleText();
    if (readable.length >= 120) return readable.slice(0, 60000);

    const selectors = [
      "[itemprop='articleBody']","article","main","[role='main']","[itemprop='text']",
      "[class*='article-body' i]","[class*='article-content' i]","[class*='story-body' i]",
      "[class*='storyBody' i]","[class*='post-content' i]","[class*='entry-content' i]",
      "[class*='rich-text' i]","[class*='prose' i]","[class*='article__body' i]",
      "[data-component='text-block']","[data-testid*='article' i]","[data-testid*='story' i]",
      "[data-testid*='content' i]","#content","#main-content",".markdown-body",".documentation"
    ];
    const candidates = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        const style = getComputedStyle(el);
        if (el.getClientRects().length && style.display !== "none" &&
            style.visibility !== "hidden" && style.opacity !== "0") candidates.add(el);
      });
    }

    // Include rich containers whose publishers use custom or undocumented markup.
    for (const el of document.querySelectorAll("main,article,section,div")) {
      if (candidates.size > 900) break;
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || style.display === "none" ||
          style.visibility === "hidden" || style.opacity === "0") continue;
      if (el.querySelectorAll("p,li,blockquote").length >= 2) candidates.add(el);
    }

    let best = "";
    let bestScore = -Infinity;
    for (const original of candidates) {
      const clone = cleanedClone(original);
      const blocks = blockText(clone);
      const text = clean(blocks.join("\n\n") || clone.innerText || clone.textContent);
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

    // Prefer publisher-provided Article schema when it contains the actual body.
    const structured = structuredArticleText();
    if (structured.length >= 120 && (structured.length > best.length || best.length < 300)) best = structured;
    if (best.length >= 120) return best.slice(0, 60000);

    // Final fallback: preserve short paragraphs and headings on simple/static sites,
    // including GitHub Pages transcript archives without semantic article markup.
    const body = document.body;
    if (!body) return best;
    const bodyClone = cleanedClone(body);
    const fallbackBlocks = [...bodyClone.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dd,dt")]
      .map(node => clean(node.innerText || node.textContent))
      .filter(value => value.length >= 18 &&
        !/^(share|read more|sign in|subscribe|advertisement|related articles?|cookie settings|pull requests?)\b/i.test(value));
    const fallback = clean(fallbackBlocks.join("\n\n"));
    if (fallback.length > best.length) best = fallback;

    if (best.length < 120) {
      const lines = clean(bodyClone.innerText || bodyClone.textContent)
        .split("\n").map(clean).filter(line => line.length >= 18 &&
          !/^(home|menu|search|sign in|log in|subscribe|accept all|privacy policy|terms of use|share|read more|pull requests?)$/i.test(line));
      const readable = clean(lines.join("\n\n"));
      if (readable.length > best.length) best = readable;
    }
    return best.slice(0, 60000);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "HOOKENGINE_EXTRACT") return;
    const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(location.hostname);
    const selection = selectedText();
    if (message?.selectionOnly) {
      const selected = selection.length >= 20 ? selection : "";
      sendResponse({
        text: selected.slice(0, 60000),
        title: document.title || "",
        url: location.href,
        sourceType: "selected-text",
        needsTranscript: false,
        extractionFailed: !selected
      });
      return;
    }
    // YouTube transcript retrieval is owned by background.js. Keep this content script focused on DOM text and selections.
    const transcript = isYouTube ? "" : nativeVideoTranscript();
    const text = isYouTube ? selection : (transcript || selection || articleText());
    const usable = text.length >= 80;
    sendResponse({
      text: usable ? text.slice(0, 60000) : "",
      title: document.title || "",
      url: location.href,
      sourceType: transcript ? (isYouTube ? "youtube-transcript" : "video-captions") : (selection ? "selected-text" : (isYouTube ? "youtube-page" : "article")),
      needsTranscript: isYouTube && !transcript && !selection,
      extractionFailed: !usable
    });
  });
})();

(() => {
  const clean = (value) => (value || "").replace(/\\u200b/g, "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();

  function youtubeTranscript() {
    const selectors = [
      "ytd-transcript-renderer #segments-container",
      "ytd-transcript-renderer .segment-text",
      "ytd-transcript-segment-renderer .segment-text",
      "[data-purpose='transcript-segment']"
    ];
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)];
      const text = clean(nodes.map(node => node.innerText || node.textContent).join("\\n"));
      if (text.length > 120) return text;
    }
    return "";
  }

  function articleText() {
    const candidates = [...document.querySelectorAll("article, main, [role='main']")];
    const root = candidates.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script, style, nav, header, footer, aside, form, button, [aria-hidden='true'], . 광고").forEach(el => el.remove());
    const paragraphs = [...clone.querySelectorAll("h1,h2,h3,p,li,blockquote,pre")];
    const text = clean(paragraphs.map(el => el.innerText || el.textContent).filter(Boolean).join("\\n\\n"));
    return text.length > 120 ? text : clean(clone.innerText || clone.textContent);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "HOOKENGINE_EXTRACT") return;
    const isYouTube = /(^|\\.)youtube\\.com$|(^|\\.)youtu\\.be$/i.test(location.hostname);
    const transcript = isYouTube ? youtubeTranscript() : "";
    const text = transcript || articleText();
    sendResponse({
      text: text.slice(0, 60000),
      title: document.title || "",
      url: location.href,
      sourceType: transcript ? "youtube-transcript" : (isYouTube ? "youtube-page" : "article"),
      needsTranscript: isYouTube && !transcript
    });
  });
})();
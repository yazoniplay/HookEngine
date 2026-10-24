async function fetchYouTubeTranscript(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const videoId = url.hostname === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : (url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1]);
    if (!videoId) return "";
    const page = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId));
    if (!page.ok) return "";
    const html = await page.text();
    const marker = html.indexOf("ytInitialPlayerResponse");
    const start = html.indexOf("{", marker);
    if (marker < 0 || start < 0) return "";
    let depth = 0, inString = false, escaped = false, player = null;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { player = JSON.parse(html.slice(start, i + 1)); } catch {}
        break;
      }
    }
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = tracks.find(t => /^en(-|$)/i.test(t.languageCode || "")) || tracks[0];
    if (!track?.baseUrl) return "";
    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set("fmt", "srv3");
    const captions = await fetch(captionUrl.toString());
    if (!captions.ok) return "";
    const xml = await captions.text();
    const transcript = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim())
      .filter(Boolean).join(" ");
    return transcript.length >= 80 ? transcript.slice(0, 60000) : "";
  } catch (error) {
    console.warn("Automatic YouTube captions unavailable:", error);
    return "";
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "HOOKENGINE_EXTRACT_ACTIVE_TAB") return;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Open a YouTube video or article first.");
      const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(new URL(tab.url).hostname);
      if (isYouTube) {
        const transcript = await fetchYouTubeTranscript(tab.url);
        if (transcript) {
          sendResponse({ ok: true, text: transcript, title: tab.title || "YouTube video", url: tab.url, sourceType: "youtube-transcript", needsTranscript: false, extractionFailed: false });
          return;
        }
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      const result = await chrome.tabs.sendMessage(tab.id, { type: "HOOKENGINE_EXTRACT" });
      if (isYouTube && result?.captionTrackUrl) {
        try {
          const captionUrl = new URL(result.captionTrackUrl);
          captionUrl.searchParams.set("fmt", "srv3");
          const captionResponse = await fetch(captionUrl.toString());
          if (captionResponse.ok) {
            const xml = await captionResponse.text();
            const transcript = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
              .map(m => m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim())
              .filter(Boolean).join(" ");
            if (transcript.length >= 80) {
              sendResponse({ ok: true, text: transcript.slice(0, 60000), title: result.title || tab.title || "YouTube video", url: tab.url, sourceType: "youtube-transcript", needsTranscript: false, extractionFailed: false });
              return;
            }
          }
        } catch (error) {
          console.warn("Could not fetch embedded YouTube captions:", error);
        }
      }
      if (isYouTube && result?.needsTranscript) {
        sendResponse({ ok: true, text: "", title: result.title || tab.title || "YouTube video", url: tab.url, sourceType: "youtube-page", needsTranscript: true, extractionFailed: true });
        return;
      }
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Could not read this page. Refresh it and try again." });
    }
  })();
  return true;
});
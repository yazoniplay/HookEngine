function decodeCaptionText(value) {
  return (value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();
}

function parseCaptionPayload(payload) {
  const raw = (payload || "").trim();
  if (!raw) return "";
  // YouTube may return XML in legacy timed-text, srv3, or JSON3 formats.
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      const lines = (data.events || []).flatMap(event =>
        (event.segs || []).map(seg => seg.utf8 || "")
      ).join("");
      if (lines.trim().length >= 40) return lines.replace(/\s+/g, " ").trim();
    } catch {}
  }
  const xmlLines = [];
  for (const match of raw.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)) {
    const line = decodeCaptionText(match[1]);
    if (line) xmlLines.push(line);
  }
  return xmlLines.join(" ").replace(/\s+/g, " ").trim();
}

function extractPlayerResponse(html) {
  const markers = ["ytInitialPlayerResponse", "ytplayer.config"];
  for (const marker of markers) {
    let offset = 0;
    while ((offset = html.indexOf(marker, offset)) !== -1) {
      const start = html.indexOf("{", offset + marker.length);
      if (start < 0 || start - offset > 160) { offset += marker.length; continue; }
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < html.length; i++) {
        const ch = html[i];
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
              const parsed = JSON.parse(html.slice(start, i + 1));
              const player = parsed?.args?.player_response;
              if (typeof player === "string") {
                try { return JSON.parse(player); } catch {}
              }
              if (parsed?.captions || parsed?.videoDetails) return parsed;
            } catch {}
            break;
          }
        }
      }
      offset += marker.length;
    }
  }
  return null;
}

async function fetchYouTubeTranscript(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const videoId = url.hostname === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : (url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1]);
    if (!videoId) return "";
    const response = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId), { credentials: "include" });
    if (!response.ok) return "";
    const player = extractPlayerResponse(await response.text());
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = tracks.find(t => /^en(-|$)/i.test(t.languageCode || "")) ||
      tracks.find(t => !t.kind || t.kind !== "asr") || tracks[0];
    if (!track?.baseUrl) return "";
    const base = track.baseUrl;
    const attempts = [
      base,
      base + (base.includes("?") ? "&" : "?") + "fmt=json3",
      base + (base.includes("?") ? "&" : "?") + "fmt=srv3"
    ];
    for (const captionUrl of [...new Set(attempts)]) {
      try {
        const captions = await fetch(captionUrl, { credentials: "include" });
        if (!captions.ok) continue;
        const transcript = parseCaptionPayload(await captions.text());
        if (transcript.length >= 80) return transcript.slice(0, 60000);
      } catch {}
    }
    return "";
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
          const captions = await fetch(result.captionTrackUrl);
          if (captions.ok) {
            const transcript = parseCaptionPayload(await captions.text());
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

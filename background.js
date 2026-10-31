import {
  SUPABASE_URL,
  SUPABASE_KEY,
  FUNCTION_URL,
  STORAGE_KEYS,
  MAX_SOURCE_CHARS,
  MIN_SOURCE_CHARS
} from "./extension/config.js";

function decodeCaptionText(value) {
  return (value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/\s+/g, " ").trim();
}

function parseCaptionPayload(payload) {
  let raw = (payload || "").trim();
  if (!raw) return "";
  raw = raw.replace(/^\)\]\}'(?:\r?\n)?/, "").trim();
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      const events = Array.isArray(data.events) ? data.events : [];
      const lines = events.map(event => {
        const segs = Array.isArray(event.segs) ? event.segs : [];
        return segs.map(seg => seg.utf8 || "").join("");
      }).join(" ");
      if (lines.trim().length >= 40) return decodeCaptionText(lines);
    } catch {}
  }
  if (/^WEBVTT\b/m.test(raw) || /-->/.test(raw)) {
    const vtt = raw
      .replace(/^\uFEFF?WEBVTT[^\n]*\n?/i, "")
      .split(/\r?\n/)
      .filter(line => line.trim() && !/^\d+$/.test(line.trim()) &&
        !/^(?:NOTE|STYLE|REGION)\b/.test(line.trim()) && !/^\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->/.test(line.trim()))
      .map(line => decodeCaptionText(line))
      .filter(Boolean)
      .join(" ");
    if (vtt.length >= 40) return vtt;
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

function normalizeCaptionUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        !["youtube.com", "www.youtube.com"].includes(url.hostname.toLowerCase()) ||
        url.pathname !== "/api/timedtext") return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function fetchCaptionTracks(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return "";
  const ranked = [...tracks].sort((a, b) => {
    const score = t => (/^en(-|$)/i.test(t.languageCode || "") ? 100 : 0) +
      (t.kind === "asr" ? 1 : 5) + (t.isTranslatable ? 0 : 2);
    return score(b) - score(a);
  });
  let best = "";
  for (const track of ranked.slice(0, 8)) {
    const baseUrl = normalizeCaptionUrl(track?.baseUrl);
    if (!baseUrl) continue;
    const attempts = [baseUrl];
    for (const fmt of ["json3", "srv3", "vtt"]) {
      try {
        const candidate = new URL(baseUrl);
        candidate.searchParams.set("fmt", fmt);
        attempts.push(candidate.toString());
      } catch {}
    }
    for (const captionUrl of [...new Set(attempts)]) {
      try {
        const captions = await fetch(captionUrl, {
          credentials: "include",
          cache: "no-store"
        });
        if (!captions.ok) continue;
        const transcript = parseCaptionPayload(await captions.text());
        if (transcript.length > best.length) best = transcript;
        if (transcript.length >= 80) return transcript.slice(0, 60000);
      } catch (error) {
        console.warn("HookEngine: caption format failed", error);
      }
    }
  }
  return best.length >= 80 ? best.slice(0, 60000) : "";
}

async function getPageCaptionTracks(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const parse = value => {
          if (typeof value !== "string") return null;
          try { return JSON.parse(value); } catch { return null; }
        };
        const candidates = [
          window.ytInitialPlayerResponse,
          parse(window.ytplayer?.config?.args?.player_response),
          parse(window.ytcfg?.get?.("PLAYER_RESPONSE"))
        ].filter(Boolean);
        for (const player of candidates) {
          const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(tracks) && tracks.length) {
            return {
              title: player?.videoDetails?.title || document.title || "",
              captionTracks: tracks.map(track => ({
                baseUrl: track.baseUrl,
                languageCode: track.languageCode,
                kind: track.kind,
                isTranslatable: track.isTranslatable
              })).filter(track => typeof track.baseUrl === "string")
            };
          }
        }
        return { title: document.title || "", captionTracks: [] };
      }
    });
    return results?.[0]?.result || { title: "", captionTracks: [] };
  } catch (error) {
    console.warn("HookEngine: could not read player data from the YouTube page", error);
    return { title: "", captionTracks: [] };
  }
}

function getYouTubeVideoId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) return "";
    const id = host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : (url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1]);
    return /^[a-zA-Z0-9_-]{11}$/.test(id || "") ? id : "";
  } catch {
    return "";
  }
}

async function fetchYouTubeTranscript(videoUrl) {
  try {
    const videoId = getYouTubeVideoId(videoUrl);
    if (!videoId) return "";

    const response = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId), {
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) {
      console.warn("HookEngine: YouTube watch request failed", response.status);
      return "";
    }
    const player = extractPlayerResponse(await response.text());
    return await fetchCaptionTracks(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []);
  } catch (error) {
    console.warn("HookEngine: YouTube transcript retrieval failed", error);
    return "";
  }
}

async function fallbackReadPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const clean = value => (value || "")
          .replace(/\u200b/g, "")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const hidden = [
          "script","style","noscript","nav","header","footer","aside","form","button","input",
          "select","textarea","iframe","svg","[aria-hidden='true']","[role='navigation']",
          "[role='banner']","[class*='cookie' i]","[id*='cookie' i]","[class*='consent' i]",
          "[class*='advert' i]","[class*='promo' i]","[class*='related' i]","[class*='share' i]"
        ].join(",");
        const candidates = [...document.querySelectorAll("article,main,[role='main'],[itemprop='articleBody'],[class*='article' i],[class*='content' i],body")];
        let best = "";
        let bestScore = -1;
        for (const el of candidates) {
          if (!el || !el.getClientRects().length) continue;
          const clone = el.cloneNode(true);
          clone.querySelectorAll(hidden).forEach(node => node.remove());
          const blocks = [...clone.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,dd,dt")]
            .map(node => clean(node.innerText || node.textContent))
            .filter(value => value.length >= 18 &&
              !/^(share|read more|sign in|subscribe|advertisement|related articles?|cookie settings|pull requests?)\\b/i.test(value));
          const text = clean(blocks.join("\\n\\n") || clone.innerText || clone.textContent);
          if (text.length < 80) continue;
          const links = [...clone.querySelectorAll("a")].reduce((n, a) => n + clean(a.innerText || a.textContent).length, 0);
          const hint = [el.id, typeof el.className === "string" ? el.className : "", el.getAttribute("itemprop") || ""].join(" ").toLowerCase();
          const score = Math.min(text.length, 30000) + (/article|content|main|body|prose/.test(hint) ? 200 : 0) - Math.min(1, links / Math.max(1, text.length)) * 1000;
          if (score > bestScore) { bestScore = score; best = text; }
        }
        return {
          text: best.slice(0, 60000),
          title: document.title || "",
          url: location.href,
          sourceType: "article",
          needsTranscript: false,
          extractionFailed: best.length < 80
        };
      }
    });
    return results?.[0]?.result || null;
  } catch (error) {
    console.warn("HookEngine: direct visible-text fallback failed", error);
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "HOOKENGINE_EXTRACT_ACTIVE_TAB" && message?.type !== "HOOKENGINE_EXTRACT_SELECTION" && message?.type !== "HOOKENGINE_GET_ACTIVE_TAB") return;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Open a YouTube video or article first.");
      const isYouTube = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(new URL(tab.url).hostname);
      if (message.type === "HOOKENGINE_GET_ACTIVE_TAB") {
        sendResponse({ ok: true, url: tab.url, title: tab.title || "" });
        return;
      }
      if (message.type === "HOOKENGINE_EXTRACT_SELECTION") {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendor/readability.js", "content.js"] });
        const selected = await chrome.tabs.sendMessage(tab.id, { type: "HOOKENGINE_EXTRACT", selectionOnly: true });
        sendResponse({ ok: true, ...selected });
        return;
      }
      if (isYouTube) {
        // Read the live player response from YouTube's page first. This avoids
        // relying only on a second, potentially different watch-page response.
        const pagePlayer = await getPageCaptionTracks(tab.id);
        let transcript = await fetchCaptionTracks(pagePlayer.captionTracks);
        if (!transcript) transcript = await fetchYouTubeTranscript(tab.url);
        if (transcript) {
          sendResponse({ ok: true, text: transcript, title: pagePlayer.title || tab.title || "YouTube video", url: tab.url, sourceType: "youtube-transcript", needsTranscript: false, extractionFailed: false });
          return;
        }
      }
      let result = null;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["vendor/readability.js", "content.js"] });
        result = await chrome.tabs.sendMessage(tab.id, { type: "HOOKENGINE_EXTRACT" });
      } catch (error) {
        console.warn("HookEngine: normal page extraction failed; trying direct visible-text fallback", error);
      }
      if (!isYouTube && (!result || (result.text || "").trim().length < 80)) {
        const fallbackResult = await fallbackReadPage(tab.id);
        if (fallbackResult && (fallbackResult.text || "").trim().length >= 80) {
          sendResponse({ ok: true, ...fallbackResult });
          return;
        }
      }
      if (!result) throw new Error("Could not read this page. Refresh it and try again.");
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

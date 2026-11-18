import {
  FUNCTION_URL,
  STORAGE_KEYS,
  MAX_SOURCE_CHARS,
  MIN_SOURCE_CHARS,
  VARIATION_SEPARATOR,
  PLATFORM_LABELS
} from "./extension/config.js";

const $ = id => document.getElementById(id);
const THEME_KEY = STORAGE_KEYS.theme;
const WRITING_PREFS_KEY = STORAGE_KEYS.writingPreferences;
const HISTORY_KEY = STORAGE_KEYS.history;
const SESSION_KEY = STORAGE_KEYS.session;

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  $("themeToggle").setAttribute("aria-label", "Switch to " + (selected === "dark" ? "light" : "dark") + " mode");
}
async function initTheme() {
  try {
    const saved = await chrome.storage.local.get(THEME_KEY);
    applyTheme(saved[THEME_KEY] || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  } catch { applyTheme("dark"); }
}
$("settingsButton").addEventListener("click",()=>chrome.runtime.openOptionsPage());
$("themeToggle").addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const button = $("themeToggle");
  const rect = button.getBoundingClientRect();
  const root = document.documentElement;
  root.style.setProperty("--theme-x", (rect.left + rect.width / 2) + "px");
  root.style.setProperty("--theme-y", (rect.top + rect.height / 2) + "px");
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const transition = document.startViewTransition(() => applyTheme(next));
    try { await transition.finished; } catch {}
  } else {
    root.classList.add("theme-switching");
    applyTheme(next);
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  }
  try { await chrome.storage.local.set({[THEME_KEY]:next}); } catch {}
});

// Accounts are no longer used. Remove any login left in storage by earlier versions.
async function removeLegacySession() {
  try { await chrome.storage.local.remove(SESSION_KEY); } catch {}
}

function showUsage(usage) {
  const remaining = usage && typeof usage.remainingDaily === "number" ? usage.remainingDaily : null;
  $("usageLine").hidden = remaining === null;
  $("usageLine").textContent = remaining === null ? "" : remaining + " credits left today";
}

function updateSourceMeta() {
  const length = $("sourceText").value.length;
  $("charCount").textContent = length.toLocaleString() + " / " + MAX_SOURCE_CHARS.toLocaleString() + " characters";
  $("sourceLabel").textContent = length > MAX_SOURCE_CHARS ? "Source too long" : ($("sourceText").value.trim() ? "Source added" : "No source");
}
$("sourceText").addEventListener("input",updateSourceMeta);
$("clearSourceBtn").addEventListener("click",()=>{
  $("sourceText").value="";$("sourceTitle").value="";$("sourceUrl").value="";
  updateSourceMeta();clearError();$("sourceText").focus();
});
function showError(message){$("errorMessage").textContent=message;$("errorMessage").hidden=false;}
function clearError(){$("errorMessage").hidden=true;}
function setLoading(loading,message="Generating drafts…") {
  $("generateBtn").disabled=loading;$("extractBtn").disabled=loading;
  $("selectionBtn").disabled=loading;$("analyzeVideoBtn").disabled=loading;
  $("loading").hidden=!loading;$("loadingText").textContent=message;
  $("generateLabel").textContent=loading?"Working…":"Generate drafts";
}
function selectedPlatforms() {
  return [...document.querySelectorAll("#platformPicker input:checked")].map(input=>input.value);
}
function updatePlatformCount() {
  const count=selectedPlatforms().length;
  $("platformCount").textContent=count+" selected";
}
document.querySelectorAll("#platformPicker input").forEach(input=>input.addEventListener("change",updatePlatformCount));

function applyExtractResponse(response) {
  if(!response?.ok) return showError(response?.error||"Could not read this page.");
  if(response.needsTranscript) {
    $("sourceTitle").value=response.title||"";
    $("sourceUrl").value=response.url||"";
    showError("No transcript was exposed by this video. Open its transcript panel, select the text and choose Use selection.");
    return;
  }
  $("sourceText").value=response.text||"";
  $("sourceTitle").value=response.title||"";
  $("sourceUrl").value=response.url||"";
  if(response.extractionFailed||$("sourceText").value.trim().length<80)
    showError("Not enough readable text was found. Select the article text or paste it manually.");
  updateSourceMeta();
}
function sendExtraction(type) {
  clearError();
  const button=type==="HOOKENGINE_EXTRACT_ACTIVE_TAB"?$("extractBtn"):$("selectionBtn");
  button.disabled=true;
  chrome.runtime.sendMessage({type},response=>{
    button.disabled=false;
    if(chrome.runtime.lastError)return showError(chrome.runtime.lastError.message);
    applyExtractResponse(response);
  });
}
$("extractBtn").addEventListener("click",()=>sendExtraction("HOOKENGINE_EXTRACT_ACTIVE_TAB"));
$("selectionBtn").addEventListener("click",()=>sendExtraction("HOOKENGINE_EXTRACT_SELECTION"));

function outputVersions(value) {
  const versions = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(VARIATION_SEPARATOR) : []);
  return versions.filter(version => typeof version === "string" && version.trim()).map(version => version.trim());
}

function renderOutputs(outputs) {
  const root = $("outputList");
  root.replaceChildren();
  const analysis = typeof outputs?.video_analysis === "string" ? outputs.video_analysis.trim() : "";
  const entries = Object.entries(outputs || {})
    .map(([key, value]) => [key, outputVersions(value)])
    .filter(([key, versions]) => PLATFORM_LABELS[key] && versions.length);
  $("resultCount").textContent = entries.length + " platforms" + (analysis ? " · Full video breakdown" : "");
  $("copyAllBtn").hidden = entries.length === 0 && !analysis;
  $("clearResultsBtn").hidden = entries.length === 0 && !analysis;

  if (analysis) {
    const card = document.createElement("article");
    card.className = "output-card video-analysis-card";
    const top = document.createElement("div");
    top.className = "output-top";
    const title = document.createElement("strong");
    title.className = "output-title";
    title.textContent = "Video breakdown & speaker profile";
    const actions = document.createElement("div");
    actions.className = "output-actions";
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.type = "button";
    copy.textContent = "Copy analysis";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(analysis);
        copy.textContent = "Copied";
        setTimeout(() => copy.textContent = "Copy analysis", 1200);
      } catch {
        showError("Clipboard access failed. Select the analysis and copy it manually.");
      }
    });
    const meta = document.createElement("span");
    meta.className = "output-meta";
    meta.textContent = analysis.length.toLocaleString() + " characters";
    actions.append(copy);
    top.append(title, meta, actions);
    const editor = document.createElement("textarea");
    editor.className = "output-text analysis-text";
    editor.value = analysis;
    editor.rows = Math.min(32, Math.max(12, Math.ceil(analysis.length / 75)));
    editor.style.minHeight = "320px";
    editor.setAttribute("aria-label", "Detailed video breakdown and speaker delivery profile");
    card.append(top, editor);
    root.append(card);
  }

  for (const [key, versions] of entries) {
    const card = document.createElement("article");
    card.className = "output-card";
    const top = document.createElement("div");
    top.className = "output-top";
    const title = document.createElement("strong");
    title.className = "output-title";
    title.textContent = PLATFORM_LABELS[key];

    const actions = document.createElement("div");
    actions.className = "output-actions";
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.type = "button";
    copy.textContent = "Copy";

    const editor = document.createElement("textarea");
    editor.className = "output-text";
    editor.value = versions[0];
    editor.rows = Math.min(12, Math.max(5, Math.ceil(editor.value.length / 75)));
    editor.setAttribute("aria-label", PLATFORM_LABELS[key] + " draft");

    const meta = document.createElement("span");
    meta.className = "output-meta";
    const threadParts = key === "x_thread"
      ? (editor.value.match(/^\s*\d+\s*(?:\/|of)\s*\d+/gm) || []).length
      : 0;
    meta.textContent = (threadParts ? threadParts + " posts · " : "") +
      editor.value.length.toLocaleString() + " characters";

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(editor.value);
        copy.textContent = "Copied";
        setTimeout(() => copy.textContent = "Copy", 1200);
      } catch {
        showError("Clipboard access failed. Select the draft and copy it manually.");
      }
    });
    actions.append(copy);
    top.append(title, meta, actions);
    card.append(top);

    if (versions.length > 1) {
      const tabs = document.createElement("div");
      tabs.className = "variation-tabs";
      versions.forEach((version, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "variation-tab" + (index === 0 ? " active" : "");
        button.textContent = "Version " + (index + 1);
        button.addEventListener("click", () => {
          editor.value = version;
          editor.rows = Math.min(12, Math.max(5, Math.ceil(version.length / 75)));
          const parts = key === "x_thread"
            ? (version.match(/^\s*\d+\s*(?:\/|of)\s*\d+/gm) || []).length
            : 0;
          meta.textContent = (parts ? parts + " posts · " : "") +
            version.length.toLocaleString() + " characters";
          tabs.querySelectorAll("button").forEach((tab, i) => tab.classList.toggle("active", i === index));
        });
        tabs.append(button);
      });
      card.append(tabs);
    }

    card.append(editor);
    root.append(card);
  }
  $("results").hidden = entries.length === 0 && !analysis;
}

$("copyAllBtn").addEventListener("click", async () => {
  const drafts = [...document.querySelectorAll(".output-card")].map(card => {
    const title = card.querySelector(".output-title")?.textContent || "Draft";
    const text = card.querySelector(".output-text")?.value || "";
    return title + "\n\n" + text;
  }).filter(Boolean).join("\n\n--------------------\n\n");
  if (!drafts) return;
  try {
    await navigator.clipboard.writeText(drafts);
    $("copyAllBtn").textContent = "Copied all";
    setTimeout(() => $("copyAllBtn").textContent = "Copy all", 1200);
  } catch {
    showError("Clipboard access failed. Copy drafts individually.");
  }
});

$("clearResultsBtn").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "HOOKENGINE_CLEAR_LAST_GENERATION" });
    $("results").hidden = true;
    $("providerNote").hidden = true;
  } catch {
    showError("Could not clear saved drafts.");
  }
});

// Local history: one list per browser, newest first. Loading an entry shows its drafts again.
async function readHistory() {
  try {
    const saved = await chrome.storage.local.get(HISTORY_KEY);
    return Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY] : [];
  } catch { return []; }
}

function formatWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function renderHistory() {
  const entries = await readHistory();
  const list = $("historyList");
  list.replaceChildren();
  $("historyEmpty").hidden = entries.length > 0;
  $("clearHistoryBtn").hidden = entries.length === 0;
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-open";
    const title = document.createElement("strong");
    title.textContent = entry.title || (entry.sourceMode === "youtube_video" ? "YouTube video" : "Untitled source");
    const meta = document.createElement("small");
    const platforms = (entry.platforms || []).map(key => PLATFORM_LABELS[key] || key).join(", ");
    meta.textContent = [formatWhen(entry.generatedAt), platforms].filter(Boolean).join(" · ");
    button.append(title, meta);
    button.addEventListener("click", () => {
      renderOutputs(entry.outputs || {});
      $("providerNote").hidden = true;
      clearError();
    });
    item.append(button);
    list.append(item);
  }
}

$("clearHistoryBtn").addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove(HISTORY_KEY);
    renderHistory();
  } catch {
    showError("Could not clear history.");
  }
});

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[HISTORY_KEY]) renderHistory();
});

async function requestGeneration(payload) {
  const result = await chrome.runtime.sendMessage({
    type: "HOOKENGINE_GENERATE",
    payload
  });
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  if (!result?.ok) throw new Error(result?.error || "Generation failed.");
  const data = result.data || {};

  renderOutputs(result.lastGeneration?.outputs || data.outputs || {});
  showUsage(data.usage);
  const notes = [];
  if (result.transcriptUsed) notes.push("Transcript-first");
  else if (payload.sourceMode === "youtube_video") notes.push("Gemini video analysis");
  if (data.provider) notes.push("Generated with " + data.provider);
  if (data.fallbackUsed) notes.push("primary provider unavailable");
  $("providerNote").textContent = notes.join(" · ");
  $("providerNote").hidden = notes.length === 0;
  return data;
}

async function restoreLastGeneration() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "HOOKENGINE_GET_LAST_GENERATION" });
    if (!result?.ok || !result.lastGeneration) return;
    const last = result.lastGeneration;
    renderOutputs(last.outputs || {});

    const notes = [];
    if (last.transcriptUsed) notes.push("Transcript-first");
    else if (last.sourceMode === "youtube_video") notes.push("Gemini video analysis");
    if (last.provider) notes.push("Generated with " + last.provider);
    if (last.fallbackUsed) notes.push("primary provider unavailable");
    $("providerNote").textContent = notes.join(" · ");
    $("providerNote").hidden = notes.length === 0;
  } catch (error) {
    console.warn("HookEngine: could not restore the previous result", error);
  }
}
async function generateForSource(sourceMode="text",sourceUrl="") {
  clearError();$("providerNote").hidden=true;
  const platforms=selectedPlatforms();
  if(!platforms.length)return showError("Choose at least one platform.");
  if (sourceMode === "text" && $("sourceText").value.trim().length < MIN_SOURCE_CHARS)
    return showError("Add at least " + MIN_SOURCE_CHARS + " characters of source text first.");
  if (sourceMode === "text" && $("sourceText").value.length > MAX_SOURCE_CHARS)
    return showError("Source text must be " + MAX_SOURCE_CHARS.toLocaleString() + " characters or fewer.");
  setLoading(true,sourceMode === "youtube_video" ? "Checking for a transcript before video analysis…" : "Generating drafts…");
  try {
    await requestGeneration({
      text:sourceMode==="text"?$("sourceText").value.trim():"",
      title:$("sourceTitle").value.trim(),
      sourceUrl:sourceUrl||$("sourceUrl").value||"",
      sourceMode,
      platforms,
      preferences:(await chrome.storage.sync.get(WRITING_PREFS_KEY))[WRITING_PREFS_KEY]||{}
    });
  } catch(error) {
    // A 429 carries the server's limit message (per-connection or global daily cap).
    showError(error.message||"Could not generate drafts.");
  }
  finally {setLoading(false);}
}
$("generateBtn").addEventListener("click",()=>generateForSource());
$("analyzeVideoBtn").addEventListener("click",()=>{
  clearError();
  chrome.runtime.sendMessage({type:"HOOKENGINE_GET_ACTIVE_TAB"},tab=>{
    if(chrome.runtime.lastError)return showError(chrome.runtime.lastError.message);
    if(!tab?.ok||!tab.url)return showError(tab?.error||"Could not read the active tab.");
    let url;try{url=new URL(tab.url);}catch{}
    const host=url?.hostname?.toLowerCase().replace(/^www\./,"");
    if(!url||!["youtube.com","m.youtube.com","music.youtube.com","youtu.be"].includes(host))
      return showError("Open a public YouTube video first.");
    $("sourceUrl").value=tab.url;$("sourceTitle").value=tab.title||"YouTube video";
    generateForSource("youtube_video",tab.url);
  });
});
initTheme();removeLegacySession();restoreLastGeneration();renderHistory();updateSourceMeta();updatePlatformCount();

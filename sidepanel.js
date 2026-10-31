import {
  SUPABASE_URL,
  SUPABASE_KEY,
  FUNCTION_URL,
  STORAGE_KEYS,
  MAX_SOURCE_CHARS,
  MIN_SOURCE_CHARS,
  VARIATION_SEPARATOR,
  PLATFORM_LABELS
} from "./extension/config.js";
import {
  restoreSession,
  signIn as authenticate,
  signOut as terminateSession
} from "./extension/auth.js";

const $ = id => document.getElementById(id);
const SESSION_KEY = STORAGE_KEYS.session;
const THEME_KEY = STORAGE_KEYS.theme;
const WRITING_PREFS_KEY = STORAGE_KEYS.writingPreferences;

let accountSession = null;
let accountUser = null;
let accountUsage = null;

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

function planLabel(plan) {
  return ({free:"FREE",pro:"PRO",trial:"PRO TRIAL",lifetime:"LIFETIME"})[plan] || "FREE";
}
function renderAccount() {
  const signedIn = !!accountUser;
  const usage = accountUsage;
  const hasProFeatures = !!usage && usage.plan !== "free";
  $("authGate").hidden = signedIn;
  document.querySelector(".app").classList.toggle("auth-required", !signedIn);
  $("upgradeButton").hidden = !signedIn || hasProFeatures;
  $("planSummary").textContent = usage ? planLabel(usage.plan) : "—";
  $("accountPanel").hidden = true;
  $("accountToggle").setAttribute("aria-expanded", "false");
  $("accountToggle").textContent = signedIn ? "Account" : "Sign in";
  $("accountStrip").classList.toggle("is-signed-in", signedIn);
  $("accountSummary").textContent = !signedIn
    ? "Sign in to use HookEngine"
    : !usage
      ? "Loading your plan and credits…"
      : usage.credits + " credits · " + usage.used + "/" + usage.limit + " daily generations used";
  document.querySelector(".account-indicator").classList.toggle("active", signedIn);
  $("signedOutPanel").hidden = signedIn;
  $("signedInPanel").hidden = !signedIn;
  if (signedIn) {
    $("signedInEmail").textContent = accountUser.email || "Signed in";
    $("extensionPlan").textContent = usage ? planLabel(usage.plan) : "LOADING";
    if (usage) {
      const trialNote = usage.plan === "trial" && usage.trialEndsAt
        ? " · Trial ends " + new Date(usage.trialEndsAt).toLocaleDateString()
        : "";
      $("dailyUsage").textContent = usage.credits + " credits left · " +
        usage.remaining + "/" + usage.limit + " daily generations remaining" + trialNote;
      $("extensionProgress").style.width = Math.min(100, usage.used / Math.max(1,usage.limit) * 100) + "%";
    } else {
      $("dailyUsage").textContent = "Usage unavailable";
      $("extensionProgress").style.width = "0%";
    }
  }
  document.querySelectorAll(".pro-option").forEach(label => {
    const input = label.querySelector("input");
    const unlocked = hasProFeatures;
    label.classList.toggle("unlocked", unlocked);
    input.disabled = !unlocked;
  });
  $("proHint").hidden = hasProFeatures;
}
$("accountToggle").addEventListener("click", () => {
  const panel = $("accountPanel");
  panel.hidden = !panel.hidden;
  $("accountToggle").setAttribute("aria-expanded", String(!panel.hidden));
});
async function loadAccountSession() {
  try {
    const restored = await restoreSession();
    accountSession = restored.session;
    accountUser = restored.user;
    if (restored.warning) showError(restored.warning);
  } catch (error) {
    console.warn("HookEngine: account session could not be restored", error);
    showError("Couldn't restore your account right now. Your saved session has not been deleted.");
  }

  renderAccount();
  if (accountUser) await refreshUsage();
}
async function refreshUsage() {
  if (!accountUser || !accountSession?.access_token) return;
  try {
    const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/hookengine_my_usage", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + accountSession.access_token,
        "Content-Type": "application/json"
      },
      body: "{}",
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.details || "Usage request failed (" + response.status + ").");
    accountUsage = {
      plan: data.plan || "free",
      credits: Number(data.credits_balance) || 0,
      creditsPerPeriod: Number(data.credits_per_period) || 0,
      used: Number(data.daily_used) || 0,
      limit: Number(data.daily_limit) || 0,
      remaining: Number(data.remaining_daily) || 0,
      trialEndsAt: data.trial_ends_at || null,
      platforms: Array.isArray(data.platforms) ? data.platforms : []
    };
  } catch (error) {
    accountUsage = null;
    showError("Couldn't load your HookEngine usage: " + (error.message || "Please retry."));
  }
  renderAccount();
}
async function signIn(source = "account") {
  const isGate = source === "gate";
  const emailInput = $(isGate ? "gateEmail" : "accountEmail");
  const passwordInput = $(isGate ? "gatePassword" : "accountPassword");
  const message = $(isGate ? "gateMessage" : "accountMessage");
  const signInButton = $(isGate ? "gateSignIn" : "accountSignIn");
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    message.textContent = "Enter your email and password.";
    return;
  }

  signInButton.disabled = true;
  message.textContent = "Signing in…";
  try {
    const result = await authenticate(email, password);
    accountSession = result.session;
    accountUser = result.user;
    $("accountPassword").value = "";
    $("gatePassword").value = "";
    message.textContent = "";
    await refreshUsage();
    renderAccount();
  } catch (error) {
    message.textContent = error.message || "Could not sign in.";
  } finally {
    signInButton.disabled = false;
  }
}

$("accountSignIn").addEventListener("click", () => signIn("account"));
$("gateSignIn").addEventListener("click", () => signIn("gate"));
$("gatePassword").addEventListener("keydown", event => {
  if (event.key === "Enter") signIn("gate");
});
$("accountPassword").addEventListener("keydown", event => {
  if (event.key === "Enter") signIn("account");
});
$("accountSignOut").addEventListener("click", async () => {
  await terminateSession();
  accountSession = null;
  accountUser = null;
  accountUsage = null;
  renderAccount();
});

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
  const entries = Object.entries(outputs || {})
    .map(([key, value]) => [key, outputVersions(value)])
    .filter(([key, versions]) => PLATFORM_LABELS[key] && versions.length);
  $("resultCount").textContent = entries.length + " platforms";
  $("copyAllBtn").hidden = entries.length === 0;
  $("clearResultsBtn").hidden = entries.length === 0;

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
  $("results").hidden = entries.length === 0;
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

async function requestGeneration(payload) {
  if (!accountSession?.access_token) throw new Error("Sign in to generate drafts.");
  const result = await chrome.runtime.sendMessage({
    type: "HOOKENGINE_GENERATE",
    payload
  });
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  if (!result?.ok) throw new Error(result?.error || "Generation failed.");
  const data = result.data || {};

  await refreshUsage();
  renderAccount();
  renderOutputs(result.lastGeneration?.outputs || data.outputs || {});
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
    renderAccount();

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
    showError(error.message||"Could not generate drafts.");
    if (accountUser) await refreshUsage();
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
initTheme();loadAccountSession();restoreLastGeneration();updateSourceMeta();updatePlatformCount();

const $ = (id) => document.getElementById(id);
const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
// Supabase legacy anon key: use as apikey only; publishable keys are currently rejected by this project's function gateway.
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYWtud3V3aXVibHhvZ2NscWR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzkxNzQsImV4cCI6MjEwNzU1NTE3NH0.mlJayLmT_xCRfGjyrA7j8bqKQVhQrjhCBD5e3czVfr0";
const FUNCTION_URL = SUPABASE_URL + "/functions/v1/hookengine-generate";
const sourceText = $("sourceText");
const generateBtn = $("generateBtn");
const analyzeVideoBtn = $("analyzeVideoBtn");
const ACCOUNT_URL = "https://yazoniplay.github.io/HookEngine/account/";
const SESSION_KEY = "hookengine-account-session";
let accountSession = null;
let accountUser = null;
let accountUsage = { plan: "free", used: 0, limit: 5, remaining: 5 };

async function loadAccountSession() {
  try {
    const saved = await chrome.storage.local.get(SESSION_KEY);
    accountSession = saved[SESSION_KEY] || null;
    if (accountSession?.expires_at && accountSession.expires_at * 1000 < Date.now() + 30000 && accountSession.refresh_token) {
      const refreshed = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: accountSession.refresh_token })
      });
      if (!refreshed.ok) throw new Error("Session expired");
      accountSession = await refreshed.json();
      accountSession.expires_at = Math.floor(Date.now() / 1000) + (accountSession.expires_in || 3600);
      await chrome.storage.local.set({ [SESSION_KEY]: accountSession });
    }
    if (accountSession?.access_token) {
      const userResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
        headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + accountSession.access_token }
      });
      if (!userResponse.ok) throw new Error("Session expired");
      accountUser = await userResponse.json();
    } else {
      accountSession = null;
    }
  } catch {
    accountSession = null; accountUser = null;
    await chrome.storage.local.remove(SESSION_KEY);
  }
  renderAccountPanel();
}
function renderAccountPanel() {
  $("signedOutPanel").hidden = !!accountUser;
  $("signedInPanel").hidden = !accountUser;
  if (accountUser) {
    $("signedInEmail").textContent = accountUser.email || "Signed in";
    $("dailyUsage").textContent = accountUsage.remaining + " of " + accountUsage.limit + " generations left today";
    $("extensionPlan").textContent = accountUsage.plan === "pro" ? "PRO" : "FREE";
    $("extensionProgress").style.width = Math.min(100, accountUsage.used / Math.max(1, accountUsage.limit) * 100) + "%";
  }
}
async function signInExtension() {
  const email = $("accountEmail").value.trim();
  const password = $("accountPassword").value;
  $("accountSignIn").disabled = true;
  $("accountMessage").textContent = "Signing in…";
  try {
    const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || "Sign in failed. Check your email and password.");
    data.expires_at = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
    accountSession = data; accountUser = data.user;
    await chrome.storage.local.set({ [SESSION_KEY]: data });
    $("accountPassword").value = "";
    $("accountMessage").textContent = "";
    renderAccountPanel();
  } catch (error) {
    $("accountMessage").textContent = error.message || "Could not sign in.";
  } finally { $("accountSignIn").disabled = false; }
}
$("accountSignIn").addEventListener("click", signInExtension);
$("accountPassword").addEventListener("keydown", event => { if (event.key === "Enter") signInExtension(); });
$("accountSignOut").addEventListener("click", async () => {
  if (accountSession?.access_token) {
    fetch(SUPABASE_URL + "/auth/v1/logout", { method:"POST", headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token} }).catch(()=>{});
  }
  accountSession=null; accountUser=null; accountUsage={plan:"free",used:0,limit:5,remaining:5};
  await chrome.storage.local.remove(SESSION_KEY);
  renderAccountPanel();
});

function applyTheme(theme) {
  const resolved = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = resolved;
  const toggle = $("themeToggle");
  if (toggle) {
    const next = resolved === "dark" ? "light" : "dark";
    toggle.setAttribute("aria-label", "Switch to " + next + " mode");
    toggle.setAttribute("title", "Switch to " + next + " mode");
  }
}

async function initTheme() {
  try {
    const saved = await chrome.storage.local.get("hookengine-theme");
    const theme = saved["hookengine-theme"] || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(theme);
  } catch {
    applyTheme(window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }
}

$("themeToggle").addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { await chrome.storage.local.set({ "hookengine-theme": next }); } catch { /* Theme still works for this session. */ }
});

function updateCount() {
  $("charCount").textContent = sourceText.value.length.toLocaleString() + " characters";
  $("sourceWords").textContent = (sourceText.value.trim().match(/\S+/g) || []).length.toLocaleString() + " words";
}
sourceText.addEventListener("input", updateCount);
function showError(message) { $("errorMessage").textContent = message; $("errorMessage").hidden = false; }
function clearError() { $("errorMessage").hidden = true; }
function setLoading(loading, message = "Finding the best angles…") {
  generateBtn.disabled = loading;
  analyzeVideoBtn.disabled = loading;
  $("loading").hidden = !loading;
  $("loadingText").textContent = message;
  $("generateIcon").style.visibility = loading ? "hidden" : "visible";
  $("generateLabel").textContent = loading ? "Working on it…" : "Make my content";
  $("analyzeVideoLabel").textContent = loading ? "Analyzing…" : "Analyze YouTube video with AI";
}

function applyExtractResponse(response) {
  if (!response?.ok) return showError(response?.error || "Could not extract page content.");
  if (response.needsTranscript) {
    $("sourceLabel").textContent = "Transcript not found";
    showError("No caption text could be read from this video. Captions visible in the player are not always exposed to extensions. Try opening the video's transcript and choosing Use selection, or paste the transcript manually.");
    $("sourceTitle").value = response.title || "";
    $("sourceUrl").value = response.url || "";
  } else {
    sourceText.value = response.text || "";
    $("sourceTitle").value = response.title || "";
    $("sourceUrl").value = response.url || "";
    const labels = {
      "youtube-transcript": "YouTube transcript",
      "video-captions": "Video captions",
      "selected-text": "Selected text",
      "article": "Page content"
    };
    $("sourceLabel").textContent = labels[response.sourceType] || "Page content";
    if (response.extractionFailed || (response.text || "").trim().length < 80) {
      showError("Not enough text was exposed to HookEngine. Try selecting the article or transcript text and choosing Use selection. Some sites restrict content or render it inside a protected player.");
    }
  }
  updateCount();
}

$("extractBtn").addEventListener("click", () => {
  clearError();
  $("extractBtn").disabled = true;
  chrome.runtime.sendMessage({ type: "HOOKENGINE_EXTRACT_ACTIVE_TAB" }, response => {
    $("extractBtn").disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    applyExtractResponse(response);
  });
});

$("selectionBtn").addEventListener("click", () => {
  clearError();
  $("selectionBtn").disabled = true;
  chrome.runtime.sendMessage({ type: "HOOKENGINE_EXTRACT_SELECTION" }, response => {
    $("selectionBtn").disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    applyExtractResponse(response);
  });
});

$("clearSourceBtn").addEventListener("click", () => {
  sourceText.value = "";
  $("sourceTitle").value = "";
  $("sourceUrl").value = "";
  $("sourceLabel").textContent = "Nothing added yet";
  clearError();
  updateCount();
  sourceText.focus();
});

async function requestGeneration(payload) {
  if (!accountSession?.access_token) throw new Error("Sign in above to use your daily generations.");
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, ...(accountSession?.access_token ? { Authorization: "Bearer " + accountSession.access_token } : {}) },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : "";
    const safeMessage = /gemini|google ai|generativelanguage/i.test(message)
      ? "AI generation could not complete. Please try again in a moment."
      : message;
    throw new Error(safeMessage || (response.status === 401 ? "The service rejected its API key. Reload the extension and try again." : "Request failed (" + response.status + ")."));
  }
  if (data.usage) accountUsage = data.usage;
  else accountUsage = { plan: accountUsage.plan, used: accountUsage.used + 1, limit: accountUsage.limit, remaining: Math.max(0, accountUsage.remaining - 1) };
  renderAccountPanel();
  for (const key of ["x_thread", "linkedin_post", "tiktok_hooks"]) {
    if (typeof data[key] !== "string") throw new Error("The server returned an invalid response. Please try again.");
    $(key).value = data[key];
  }
  $("results").hidden = false;
  return data;
}

analyzeVideoBtn.addEventListener("click", () => {
  clearError();
  chrome.runtime.sendMessage({ type: "HOOKENGINE_GET_ACTIVE_TAB" }, async tab => {
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    if (!tab?.ok || !tab.url) return showError(tab?.error || "Could not read the active tab.");
    let parsedUrl;
    try { parsedUrl = new URL(tab.url); } catch {}
    const host = parsedUrl?.hostname?.toLowerCase().replace(/^www\./, "");
    if (!parsedUrl || !["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
      return showError("Open a public YouTube video first, then choose Analyze YouTube video with AI.");
    }
    $("sourceUrl").value = tab.url;
    $("sourceTitle").value = tab.title || "YouTube video";
    setLoading(true, "Analyzing the YouTube video…");
    try {
      const data = await requestGeneration({
        text: "",
        title: $("sourceTitle").value.trim(),
        sourceUrl: tab.url,
        sourceMode: "youtube_video"
      });
      $("sourceLabel").textContent = data.sourceMethod === "server-transcript" ? "YouTube transcript · server fallback" : "AI video analysis";
      sourceText.value = "";
      if (data.sourceMethod === "server-transcript") {
        showError("The video was processed using an alternate transcript route.");
      } else {
        clearError();
      }
      updateCount();
    } catch (error) {
      showError(error.message || "Could not analyze this YouTube video.");
    } finally {
      setLoading(false);
    }
  });
});

generateBtn.addEventListener("click", async () => {
  clearError();
  if (sourceText.value.trim().length < 80) return showError("Add at least 80 characters of source text before generating. For a YouTube video, use Analyze YouTube video with AI instead.");
  setLoading(true);
  try {
    await requestGeneration({
      text: sourceText.value.trim(),
      title: $("sourceTitle").value.trim(),
      sourceUrl: $("sourceUrl").value || "",
      sourceMode: "text"
    });
  } catch (error) {
    showError(error.message || "Could not connect to Supabase. Check the function configuration.");
  } finally {
    setLoading(false);
  }
});

document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const value = $(button.dataset.copy).value;
  if (!value) return;
  const label = button.querySelector("span");
  try {
    await navigator.clipboard.writeText(value);
    if (label) label.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      if (label) label.textContent = "Copy";
      button.classList.remove("copied");
    }, 1300);
  } catch {
    showError("Clipboard access failed. Select the output and copy it manually.");
  }
}));

initTheme();
loadAccountSession();
updateCount();

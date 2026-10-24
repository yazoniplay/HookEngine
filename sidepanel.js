const $ = (id) => document.getElementById(id);
const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
// Supabase legacy anon key: use as apikey only; publishable keys are currently rejected by this project's function gateway.
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYWtud3V3aXVibHhvZ2NscWR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzkxNzQsImV4cCI6MjEwNzU1NTE3NH0.mlJayLmT_xCRfGjyrA7j8bqKQVhQrjhCBD5e3czVfr0";
const FUNCTION_URL = SUPABASE_URL + "/functions/v1/hookengine-generate";
const sourceText = $("sourceText");
const generateBtn = $("generateBtn");

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
function setLoading(loading) {
  generateBtn.disabled = loading;
  $("loading").hidden = !loading;
  $("generateIcon").style.visibility = loading ? "hidden" : "visible";
  $("generateLabel").textContent = loading ? "Working on it…" : "Make my content";
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

generateBtn.addEventListener("click", async () => {
  clearError();
  if (sourceText.value.trim().length < 80) return showError("Add at least 80 characters of source text before generating.");
  setLoading(true);
  try {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY
      },
      body: JSON.stringify({
        text: sourceText.value.trim(),
        title: $("sourceTitle").value.trim(),
        sourceUrl: $("sourceUrl").value || ""
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Supabase rejected the API key. Reload the extension and try again." : "Request failed (" + response.status + ")."));
    for (const key of ["x_thread", "linkedin_post", "tiktok_hooks"]) {
      if (typeof data[key] !== "string") throw new Error("The server returned an invalid response. Please try again.");
      $(key).value = data[key];
    }
    $("results").hidden = false;
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
updateCount();

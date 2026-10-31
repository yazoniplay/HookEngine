import { STORAGE_KEYS } from "./extension/config.js";

const defaults = {
  tone: "balanced",
  style: "platform_native",
  length: "platform_default",
  audience: ""
};
const fields = ["tone", "style", "length", "audience"];
const $ = id => document.getElementById(id);

const labels = {
  tone: { balanced: "Balanced", professional: "Professional", conversational: "Conversational", confident: "Confident", witty: "Witty", educational: "Educational", inspiring: "Inspiring" },
  style: { platform_native: "Platform-native", storytelling: "Storytelling", direct: "Direct and concise", analytical: "Analytical", personal: "Personal and first-person", bold: "Bold opening" },
  length: { platform_default: "Platform default length", short: "Short", medium: "Medium", detailed: "Detailed" }
};
function renderProfilePreview() {
  const tone = labels.tone[$("tone").value] || labels.tone.balanced;
  const style = labels.style[$("style").value] || labels.style.platform_native;
  const length = labels.length[$("length").value] || labels.length.platform_default;
  $("profileSummary").textContent = [tone, style, length].join(" · ");
  const audience = $("audience").value.trim();
  $("profileAudience").textContent = audience ? "Audience: " + audience : "Audience: not specified";
}
for (const key of fields) $(key).addEventListener("input", renderProfilePreview);
for (const key of fields.slice(0, 3)) $(key).addEventListener("change", renderProfilePreview);

async function init() {
  try {
    const saved = await chrome.storage.sync.get(STORAGE_KEYS.writingPreferences);
    const preferences = {
      ...defaults,
      ...(saved[STORAGE_KEYS.writingPreferences] || {})
    };
    for (const key of fields) $(key).value = preferences[key] || defaults[key];
    renderProfilePreview();

    const theme = await chrome.storage.local.get(STORAGE_KEYS.theme);
    document.documentElement.dataset.theme = theme[STORAGE_KEYS.theme] || "dark";
  } catch {
    // Keep usable defaults if browser storage is temporarily unavailable.
  }
}

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const preferences = {};
  for (const key of fields) preferences[key] = $(key).value.trim();

  const status = $("saveStatus");
  const saveButton = $("settingsForm").querySelector('[type="submit"]');
  saveButton.disabled = true;
  status.textContent = "Saving…";
  try {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.writingPreferences]: preferences
    });
    status.textContent = "Saved";
  } catch {
    status.textContent = "Could not save preferences";
  } finally {
    saveButton.disabled = false;
  }
});

init();

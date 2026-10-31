import { STORAGE_KEYS } from "./extension/config.js";

const defaults = {
  tone: "balanced",
  style: "platform_native",
  length: "platform_default",
  audience: ""
};
const fields = ["tone", "style", "length", "audience"];
const $ = id => document.getElementById(id);

async function init() {
  try {
    const saved = await chrome.storage.sync.get(STORAGE_KEYS.writingPreferences);
    const preferences = {
      ...defaults,
      ...(saved[STORAGE_KEYS.writingPreferences] || {})
    };
    for (const key of fields) $(key).value = preferences[key] || defaults[key];

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

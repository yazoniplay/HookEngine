chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "HOOKENGINE_EXTRACT_ACTIVE_TAB") return;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error("Open a YouTube video or article first.");
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      const result = await chrome.tabs.sendMessage(tab.id, { type: "HOOKENGINE_EXTRACT" });
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Could not read this page. Refresh it and try again." });
    }
  })();
  return true;
});
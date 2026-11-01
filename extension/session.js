import { SUPABASE_URL, SUPABASE_KEY, STORAGE_KEYS } from "./config.js";

const LOCK_KEY = STORAGE_KEYS.sessionRefreshLock;
const LOCK_TTL_MS = 20000;
let refreshInFlight = null;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeOwnerId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "refresh-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

export async function getStoredSession() {
  const saved = await chrome.storage.local.get(STORAGE_KEYS.session);
  return saved[STORAGE_KEYS.session] || null;
}

export async function saveStoredSession(session) {
  if (session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });
  } else {
    await clearStoredSession();
  }
}

export async function clearStoredSession() {
  await chrome.storage.local.remove(STORAGE_KEYS.session);
}

async function acquireRefreshLock() {
  const owner = makeOwnerId();
  const deadline = Date.now() + LOCK_TTL_MS + 1000;

  while (Date.now() < deadline) {
    const saved = await chrome.storage.local.get(LOCK_KEY);
    const current = saved[LOCK_KEY];
    if (!current || Number(current.expiresAt) <= Date.now()) {
      await chrome.storage.local.set({
        [LOCK_KEY]: { owner, expiresAt: Date.now() + LOCK_TTL_MS }
      });
      const confirmed = await chrome.storage.local.get(LOCK_KEY);
      if (confirmed[LOCK_KEY]?.owner === owner) return owner;
    }
    await pause(100);
  }

  throw new Error("A session refresh is already in progress. Retry in a moment.");
}

async function releaseRefreshLock(owner) {
  const saved = await chrome.storage.local.get(LOCK_KEY);
  if (saved[LOCK_KEY]?.owner === owner) {
    await chrome.storage.local.remove(LOCK_KEY);
  }
}

async function performRefresh(expectedRefreshToken) {
  const owner = await acquireRefreshLock();
  try {
    const session = await getStoredSession();
    if (!session?.access_token) {
      return { session: null, warning: null, cleared: false };
    }

    // Another request may have completed a rotation while this caller waited.
    if (expectedRefreshToken && session.refresh_token !== expectedRefreshToken) {
      return { session, warning: null, cleared: false };
    }

    if (!session.refresh_token) {
      await clearStoredSession();
      return { session: null, warning: null, cleared: true };
    }

    let response;
    try {
      response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
    } catch {
      return {
        session,
        warning: "Couldn't reach sign-in. Your saved session is preserved; check your connection and retry.",
        cleared: false
      };
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        await clearStoredSession();
        return { session: null, warning: null, cleared: true };
      }
      return {
        session,
        warning: "Sign-in is temporarily unavailable. Your saved session is preserved.",
        cleared: false
      };
    }

    if (!data.access_token) {
      return {
        session,
        warning: "The sign-in service returned an invalid refresh response. Your saved session is preserved.",
        cleared: false
      };
    }

    const refreshedSession = {
      ...session,
      ...data,
      user: data.user || session.user || null,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600)
    };
    await saveStoredSession(refreshedSession);
    return { session: refreshedSession, warning: null, cleared: false };
  } finally {
    await releaseRefreshLock(owner);
  }
}

// All extension-page refreshes are routed through the one MV3 service worker.
// The persisted lock protects against worker restarts while a refresh is pending.
export async function refreshSessionInServiceWorker(options = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh(options.expectedRefreshToken || null);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function refreshSession(options = {}) {
  if (typeof document !== "undefined") {
    return chrome.runtime.sendMessage({
      type: "HOOKENGINE_REFRESH_SESSION",
      expectedRefreshToken: options.expectedRefreshToken || null
    });
  }
  return refreshSessionInServiceWorker(options);
}

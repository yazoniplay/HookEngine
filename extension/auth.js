import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import {
  getStoredSession,
  saveStoredSession,
  clearStoredSession,
  refreshSession
} from "./session.js";

async function parseResponse(response) {
  return response.json().catch(() => ({}));
}

function cachedIdentity(session, warning) {
  return {
    session,
    user: session?.user || null,
    warning
  };
}

export async function signIn(email, password) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email: email.trim(), password })
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new Error(data.msg || data.message || "Check your email and password.");
  }
  if (!data.access_token || !data.user) {
    throw new Error("The sign-in service returned an incomplete session.");
  }

  data.expires_at = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  await saveStoredSession(data);
  return { session: data, user: data.user };
}

export async function restoreSession() {
  let session = await getStoredSession();
  if (!session?.access_token) {
    if (session) await clearStoredSession();
    return { session: null, user: null, warning: null };
  }

  if (session.expires_at && session.expires_at * 1000 < Date.now() + 30000) {
    if (!session.refresh_token) {
      await clearStoredSession();
      return { session: null, user: null, warning: null };
    }

    let refreshed;
    try {
      refreshed = await refreshSession();
    } catch {
      return cachedIdentity(session, "Couldn't reach sign-in. Your saved session is preserved; check your connection and retry.");
    }
    if (refreshed?.warning) return cachedIdentity(refreshed.session || session, refreshed.warning);
    if (!refreshed?.session?.access_token) {
      return { session: null, user: null, warning: null };
    }
    session = refreshed.session;
  }

  let response;
  try {
    response = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + session.access_token
      }
    });
  } catch {
    return cachedIdentity(session, "Couldn't verify your saved session. Check your connection; your session has been kept.");
  }

  if (response.status === 401 || response.status === 403) {
    await clearStoredSession();
    return { session: null, user: null, warning: null };
  }
  if (!response.ok) {
    return cachedIdentity(session, "Sign-in verification is temporarily unavailable. Your saved session is preserved.");
  }

  const user = await parseResponse(response);
  if (!user?.id) {
    return cachedIdentity(session, "The sign-in service returned an invalid user response. Your saved session is preserved.");
  }
  return { session, user, warning: null };
}

export async function signOut() {
  const session = await getStoredSession();
  await clearStoredSession();
  if (!session?.access_token) return;

  try {
    await fetch(SUPABASE_URL + "/auth/v1/logout", {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + session.access_token
      }
    });
  } catch {
    // Local sign-out is immediate even when the network is unavailable.
  }
}

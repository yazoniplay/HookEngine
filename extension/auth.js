import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { getStoredSession, saveStoredSession, clearStoredSession, refreshSession } from "./session.js";

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


import { SUPABASE_URL, SUPABASE_KEY, STORAGE_KEYS } from "./config.js";

async function readStoredSession() {
  const saved = await chrome.storage.local.get(STORAGE_KEYS.session);
  return saved[STORAGE_KEYS.session] || null;
}

async function writeStoredSession(session) {
  if (session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: session });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.session);
  }
}

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
  await writeStoredSession(data);
  return { session: data, user: data.user };
}

export async function restoreSession() {
  let session = await readStoredSession();
  if (!session?.access_token) {
    if (session) await writeStoredSession(null);
    return { session: null, user: null, warning: null };
  }

  if (session.expires_at && session.expires_at * 1000 < Date.now() + 30000) {
    if (!session.refresh_token) {
      await writeStoredSession(null);
      return { session: null, user: null, warning: null };
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
      return cachedIdentity(session, "Couldn't reach sign-in. Your saved session is preserved; check your connection and retry.");
    }

    const data = await parseResponse(response);
    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        await writeStoredSession(null);
        return { session: null, user: null, warning: null };
      }
      return cachedIdentity(session, "Sign-in is temporarily unavailable. Your saved session is preserved.");
    }
    if (!data.access_token) {
      return cachedIdentity(session, "The sign-in service returned an invalid refresh response. Your saved session is preserved.");
    }

    session = data;
    session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    await writeStoredSession(session);
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
    await writeStoredSession(null);
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
  const session = await readStoredSession();
  await writeStoredSession(null);
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

import test from "node:test";
import assert from "node:assert/strict";
import { restoreSession, signIn, signOut } from "../extension/auth.js";

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return { [key]: store.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
      async remove(key) { store.delete(key); }
    }
  }
};

const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return data; }
});

const savedSession = () => ({
  access_token: "old-access-token",
  refresh_token: "refresh-token",
  expires_at: Math.floor(Date.now() / 1000) - 60,
  user: { id: "user-1", email: "user@example.com" }
});

test("simultaneous session restores share one refresh request", async () => {
  store.set("hookengine-account-session", savedSession());
  const previousFetch = globalThis.fetch;
  let refreshCalls = 0;
  const pending = [];
  globalThis.fetch = async url => {
    if (String(url).includes("grant_type=refresh_token")) {
      refreshCalls++;
      return new Promise(resolve => pending.push(resolve));
    }
    return jsonResponse({ id: "user-1", email: "user@example.com" });
  };
  try {
    const first = restoreSession();
    const second = restoreSession();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const resolve of pending) {
      resolve(jsonResponse({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
        user: { id: "user-1", email: "user@example.com" }
      }));
    }
    const results = await Promise.all([first, second]);
    assert.equal(refreshCalls, 1, "concurrent restores must make one refresh request");
    assert.equal(results[0].session.access_token, "rotated-access-token");
    assert.equal(results[1].session.access_token, "rotated-access-token");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("refresh server errors preserve the stored session", async () => {
  const session = savedSession();
  store.set("hookengine-account-session", session);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ message: "temporarily unavailable" }, 503);
  try {
    const result = await restoreSession();
    assert.equal(result.session.refresh_token, session.refresh_token);
    assert.equal(store.get("hookengine-account-session").refresh_token, session.refresh_token);
    assert.match(result.warning, /preserved/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("invalid refresh statuses clear the expired session", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const status of [400, 401, 403]) {
      store.set("hookengine-account-session", savedSession());
      globalThis.fetch = async () => jsonResponse({ message: "refresh token invalid" }, status);
      const result = await restoreSession();
      assert.equal(result.session, null, "status " + status + " must clear the session");
      assert.equal(store.has("hookengine-account-session"), false, "status " + status + " must remove stored credentials");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("network failure during refresh preserves the stored session", async () => {
  const session = savedSession();
  store.set("hookengine-account-session", session);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  try {
    const result = await restoreSession();
    assert.equal(result.session.refresh_token, "refresh-token");
    assert.equal(result.user.id, "user-1");
    assert.match(result.warning, /session is preserved/i);
    assert.equal(store.get("hookengine-account-session").refresh_token, "refresh-token");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("invalid refresh credentials clear the expired session", async () => {
  store.set("hookengine-account-session", savedSession());
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ message: "refresh token invalid" }, 401);
  try {
    const result = await restoreSession();
    assert.equal(result.session, null);
    assert.equal(store.has("hookengine-account-session"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("successful refresh and user verification update the session", async () => {
  store.set("hookengine-account-session", savedSession());
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (String(url).includes("grant_type=refresh_token")) {
      return jsonResponse({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        user: { id: "user-1", email: "user@example.com" }
      });
    }
    return jsonResponse({ id: "user-1", email: "user@example.com" });
  };
  try {
    const result = await restoreSession();
    assert.equal(calls, 2);
    assert.equal(result.session.access_token, "new-access-token");
    assert.equal(result.user.id, "user-1");
    assert.equal(store.get("hookengine-account-session").refresh_token, "new-refresh-token");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("sign-in stores the returned session and user", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3600,
    user: { id: "user-2", email: "new@example.com" }
  });
  try {
    const result = await signIn(" new@example.com ", "password");
    assert.equal(result.user.id, "user-2");
    assert.equal(store.get("hookengine-account-session").user.email, "new@example.com");
    assert.ok(store.get("hookengine-account-session").expires_at > Date.now() / 1000);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("sign-out clears local credentials even if the network is unavailable", async () => {
  store.set("hookengine-account-session", {
    access_token: "access-token",
    refresh_token: "refresh-token"
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  try {
    await signOut();
    assert.equal(store.has("hookengine-account-session"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

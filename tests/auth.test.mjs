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

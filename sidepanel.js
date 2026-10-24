const $ = (id) => document.getElementById(id);
const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
const SUPABASE_KEY = "sb_publishable_3_4_b-tj5VnnD-OR2bgX_g8_8mktyac9";
const FUNCTION_URL = SUPABASE_URL + "/functions/v1/hookengine-generate";
const sourceText = $("sourceText");
const generateBtn = $("generateBtn");
let session = null;

function updateCount() { $("charCount").textContent = sourceText.value.length.toLocaleString() + " characters"; }
sourceText.addEventListener("input", updateCount);
function showError(message) { $("errorMessage").textContent = message; $("errorMessage").hidden = false; }
function clearError() { $("errorMessage").hidden = true; }
function setLoading(loading) { generateBtn.disabled = loading || !session?.access_token; $("loading").hidden = !loading; $("generateIcon").textContent = loading ? "" : "✦"; $("generateLabel").textContent = loading ? "Generating…" : (session?.access_token ? "Generate content" : "Sign in to generate"); }

async function authRequest(path, body) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || "Authentication failed.");
  return data;
}
async function saveSession(next) {
  session = next && next.access_token ? next : null;
  if (session) {
    session.expires_at = session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    await chrome.storage.local.set({ hookengine_session: session });
  } else {
    await chrome.storage.local.remove("hookengine_session");
  }
  renderAuth();
}
function renderAuth() {
  const signedIn = Boolean(session?.access_token);
  $("authForm").hidden = signedIn;
  $("signedIn").hidden = !signedIn;
  $("authStatus").textContent = signedIn ? "SIGNED IN" : "SIGNED OUT";
  $("signedInEmail").textContent = session?.user?.email || "Account connected";
  $("authHelp").textContent = signedIn ? "Your account is connected through Supabase Auth." : "Sign in or create an account to generate content securely.";
  generateBtn.disabled = !signedIn;
  $("generateLabel").textContent = signedIn ? "Generate content" : "Sign in to generate";
}
async function restoreSession() {
  const stored = await chrome.storage.local.get("hookengine_session");
  session = stored.hookengine_session || null;
  if (session?.refresh_token && session.expires_at < Math.floor(Date.now() / 1000) + 60) {
    try {
      const refreshed = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
      await saveSession(refreshed);
      return;
    } catch { await saveSession(null); return; }
  }
  renderAuth();
}
$("signInBtn").addEventListener("click", async () => {
  clearError();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || !password) return showError("Enter your email and password.");
  $("signInBtn").disabled = $("signUpBtn").disabled = true;
  try { await saveSession(await authRequest("token?grant_type=password", { email, password })); }
  catch (error) { showError(error.message); }
  finally { $("signInBtn").disabled = $("signUpBtn").disabled = false; }
});
$("signUpBtn").addEventListener("click", async () => {
  clearError();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || password.length < 8) return showError("Enter a valid email and a password with at least 8 characters.");
  $("signInBtn").disabled = $("signUpBtn").disabled = true;
  try {
    const data = await authRequest("signup", { email, password });
    if (data.access_token) await saveSession(data);
    else $("authHelp").textContent = "Account created. Check your email to confirm it, then sign in.";
  } catch (error) { showError(error.message); }
  finally { $("signInBtn").disabled = $("signUpBtn").disabled = false; }
});
$("signOutBtn").addEventListener("click", async () => {
  clearError();
  try {
    if (session?.access_token) await fetch(SUPABASE_URL + "/auth/v1/logout", { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + session.access_token } });
  } finally { await saveSession(null); }
});
$("extractBtn").addEventListener("click", () => {
  clearError(); $("extractBtn").disabled = true;
  chrome.runtime.sendMessage({ type: "HOOKENGINE_EXTRACT_ACTIVE_TAB" }, response => {
    $("extractBtn").disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    if (!response?.ok) return showError(response?.error || "Could not extract page content.");
    if (response.needsTranscript) {
      $("sourceLabel").textContent = "Transcript not found";
      showError("YouTube did not expose its transcript. Open YouTube’s “Show transcript” panel, then click Read current tab again.");
      if (response.text) sourceText.value = response.text;
    } else {
      sourceText.value = response.text || "";
      $("sourceTitle").value = response.title || "";
      $("sourceUrl").value = response.url || "";
      $("sourceLabel").textContent = response.sourceType === "youtube-transcript" ? "YouTube transcript" : "Page content";
    }
    updateCount();
  });
});
generateBtn.addEventListener("click", async () => {
  clearError();
  if (!session?.access_token) return showError("Sign in to your HookEngine account first.");
  if (sourceText.value.trim().length < 80) return showError("Add at least 80 characters of source text before generating.");
  setLoading(true);
  try {
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ text: sourceText.value.trim(), title: $("sourceTitle").value.trim(), sourceUrl: $("sourceUrl").value || "" })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Session expired. Sign in again." : "Request failed (" + response.status + ")."));
    for (const key of ["x_thread", "linkedin_post", "tiktok_hooks"]) {
      if (typeof data[key] !== "string") throw new Error("The server returned an invalid response. Please try again.");
      $(key).value = data[key];
    }
    $("results").hidden = false;
  } catch (error) {
    showError(error.message || "Could not connect to Supabase. Check the function configuration.");
  } finally { setLoading(false); }
});
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const value = $(button.dataset.copy).value;
  if (!value) return;
  try { await navigator.clipboard.writeText(value); button.textContent = "Copied ✓"; setTimeout(() => { button.textContent = "Copy ↗"; }, 1300); }
  catch { showError("Clipboard access failed. Select the output and copy it manually."); }
}));
updateCount();
restoreSession().catch(error => showError("Could not restore your session: " + error.message));

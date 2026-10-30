const $ = id => document.getElementById(id);
const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYWtud3V3aXVibHhvZ2NscWR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzkxNzQsImV4cCI6MjEwNzU1NTE3NH0.mlJayLmT_xCRfGjyrA7j8bqKQVhQrjhCBD5e3czVfr0";
const FUNCTION_URL = SUPABASE_URL + "/functions/v1/hookengine-generate";
const SESSION_KEY = "hookengine-account-session";
const THEME_KEY = "hookengine-theme";
const PLATFORM_LABELS = {
  x_thread: "X thread",
  linkedin_post: "LinkedIn post",
  tiktok_hooks: "TikTok hooks",
  instagram_caption: "Instagram caption",
  threads_posts: "Threads posts",
  facebook_post: "Facebook post"
};
let accountSession = null;
let accountUser = null;
let accountUsage = { plan:"free", used:0, limit:5, remaining:5 };

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  $("themeToggle").setAttribute("aria-label", "Switch to " + (selected === "dark" ? "light" : "dark") + " mode");
}
async function initTheme() {
  try {
    const saved = await chrome.storage.local.get(THEME_KEY);
    applyTheme(saved[THEME_KEY] || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  } catch { applyTheme("dark"); }
}
$("themeToggle").addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { await chrome.storage.local.set({[THEME_KEY]:next}); } catch {}
});

function renderAccount() {
  const signedIn = !!accountUser;
  $("accountPanel").hidden = true;
  $("accountToggle").textContent = signedIn ? "Account" : "Sign in";
  $("accountSummary").textContent = signedIn
    ? (accountUser.email || "Signed in") + " · " + accountUsage.remaining + " left today"
    : "Sign in to use HookEngine";
  document.querySelector(".account-indicator").classList.toggle("active", signedIn);
  $("signedOutPanel").hidden = signedIn;
  $("signedInPanel").hidden = !signedIn;
  if (signedIn) {
    $("signedInEmail").textContent = accountUser.email || "Signed in";
    $("dailyUsage").textContent = accountUsage.remaining + " of " + accountUsage.limit + " generations left today";
    $("extensionPlan").textContent = accountUsage.plan.toUpperCase();
    $("extensionProgress").style.width = Math.min(100, accountUsage.used / Math.max(1,accountUsage.limit) * 100) + "%";
  }
  document.querySelectorAll(".pro-option").forEach(label => {
    const input = label.querySelector("input");
    const unlocked = accountUsage.plan === "pro";
    label.classList.toggle("unlocked", unlocked);
    input.disabled = !unlocked;
  });
  $("proHint").hidden = accountUsage.plan === "pro";
}
$("accountToggle").addEventListener("click", () => {
  $("accountPanel").hidden = !$("accountPanel").hidden;
});
async function loadAccountSession() {
  try {
    const saved = await chrome.storage.local.get(SESSION_KEY);
    accountSession = saved[SESSION_KEY] || null;
    if (accountSession?.expires_at && accountSession.expires_at * 1000 < Date.now() + 30000 && accountSession.refresh_token) {
      const refreshed = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method:"POST",headers:{apikey:SUPABASE_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({refresh_token:accountSession.refresh_token})
      });
      if (!refreshed.ok) throw new Error("Session expired");
      accountSession = await refreshed.json();
      accountSession.expires_at = Math.floor(Date.now()/1000) + (accountSession.expires_in || 3600);
      await chrome.storage.local.set({[SESSION_KEY]:accountSession});
    }
    if (accountSession?.access_token) {
      const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
        headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token}
      });
      if (!response.ok) throw new Error("Session expired");
      accountUser = await response.json();
    } else accountSession = null;
  } catch {
    accountSession = null; accountUser = null;
    await chrome.storage.local.remove(SESSION_KEY);
  }
  renderAccount();
  if (accountUser) await refreshUsage();
}
async function refreshUsage() {
  if (!accountUser || !accountSession?.access_token) return;
  try {
    const start = new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate())).toISOString();
    const [subs,rows] = await Promise.all([
      fetch(SUPABASE_URL+"/rest/v1/hookengine_subscriptions?select=plan,status&user_id=eq."+encodeURIComponent(accountUser.id)+"&limit=1",{headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token}}).then(r=>r.ok?r.json():[]),
      fetch(SUPABASE_URL+"/rest/v1/hookengine_generations?select=id,status&user_id=eq."+encodeURIComponent(accountUser.id)+"&created_at=gte."+encodeURIComponent(start)+"&status=in.%28reserved%2Ccompleted%29&limit=100",{headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token}}).then(r=>r.ok?r.json():[])
    ]);
    const sub=subs[0]||{plan:"free",status:"inactive"};
    accountUsage.plan=sub.plan==="pro"&&sub.status==="active"?"pro":"free";
    accountUsage.limit=accountUsage.plan==="pro"?100:5;
    accountUsage.used=rows.length;
    accountUsage.remaining=Math.max(0,accountUsage.limit-accountUsage.used);
  } catch {}
  renderAccount();
}
async function signIn() {
  const email=$("accountEmail").value.trim(),password=$("accountPassword").value;
  $("accountSignIn").disabled=true;$("accountMessage").textContent="Signing in…";
  try {
    const response=await fetch(SUPABASE_URL+"/auth/v1/token?grant_type=password",{
      method:"POST",headers:{apikey:SUPABASE_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({email,password})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.msg||data.message||"Check your email and password.");
    data.expires_at=Math.floor(Date.now()/1000)+(data.expires_in||3600);
    accountSession=data;accountUser=data.user;
    await chrome.storage.local.set({[SESSION_KEY]:data});
    $("accountPassword").value="";$("accountMessage").textContent="";
    await refreshUsage();renderAccount();
  } catch(error) {$("accountMessage").textContent=error.message||"Could not sign in.";}
  finally {$("accountSignIn").disabled=false;}
}
$("accountSignIn").addEventListener("click",signIn);
$("accountPassword").addEventListener("keydown",e=>{if(e.key==="Enter")signIn();});
$("accountSignOut").addEventListener("click",async()=>{
  if(accountSession?.access_token) fetch(SUPABASE_URL+"/auth/v1/logout",{method:"POST",headers:{apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token}}).catch(()=>{});
  accountSession=null;accountUser=null;accountUsage={plan:"free",used:0,limit:5,remaining:5};
  await chrome.storage.local.remove(SESSION_KEY);renderAccount();
});
function updateSourceMeta() {
  $("charCount").textContent=($("sourceText").value.length).toLocaleString()+" characters";
  $("sourceLabel").textContent=$("sourceText").value.trim()?"Source added":"No source";
}
$("sourceText").addEventListener("input",updateSourceMeta);
$("clearSourceBtn").addEventListener("click",()=>{
  $("sourceText").value="";$("sourceTitle").value="";$("sourceUrl").value="";
  updateSourceMeta();clearError();$("sourceText").focus();
});
function showError(message){$("errorMessage").textContent=message;$("errorMessage").hidden=false;}
function clearError(){$("errorMessage").hidden=true;}
function setLoading(loading,message="Generating drafts…") {
  $("generateBtn").disabled=loading;$("extractBtn").disabled=loading;
  $("selectionBtn").disabled=loading;$("analyzeVideoBtn").disabled=loading;
  $("loading").hidden=!loading;$("loadingText").textContent=message;
  $("generateLabel").textContent=loading?"Working…":"Generate drafts";
}
function selectedPlatforms() {
  return [...document.querySelectorAll("#platformPicker input:checked")].map(input=>input.value);
}
function updatePlatformCount() {
  const count=selectedPlatforms().length;
  $("platformCount").textContent=count+" selected";
}
document.querySelectorAll("#platformPicker input").forEach(input=>input.addEventListener("change",updatePlatformCount));

function applyExtractResponse(response) {
  if(!response?.ok) return showError(response?.error||"Could not read this page.");
  if(response.needsTranscript) {
    $("sourceTitle").value=response.title||"";
    $("sourceUrl").value=response.url||"";
    showError("No transcript was exposed by this video. Open its transcript panel, select the text and choose Use selection.");
    return;
  }
  $("sourceText").value=response.text||"";
  $("sourceTitle").value=response.title||"";
  $("sourceUrl").value=response.url||"";
  if(response.extractionFailed||$("sourceText").value.trim().length<80)
    showError("Not enough readable text was found. Select the article text or paste it manually.");
  updateSourceMeta();
}
function sendExtraction(type) {
  clearError();
  const button=type==="HOOKENGINE_EXTRACT_ACTIVE_TAB"?$("extractBtn"):$("selectionBtn");
  button.disabled=true;
  chrome.runtime.sendMessage({type},response=>{
    button.disabled=false;
    if(chrome.runtime.lastError)return showError(chrome.runtime.lastError.message);
    applyExtractResponse(response);
  });
}
$("extractBtn").addEventListener("click",()=>sendExtraction("HOOKENGINE_EXTRACT_ACTIVE_TAB"));
$("selectionBtn").addEventListener("click",()=>sendExtraction("HOOKENGINE_EXTRACT_SELECTION"));

function renderOutputs(outputs) {
  const root=$("outputList");root.replaceChildren();
  const entries=Object.entries(outputs||{}).filter(([key,value])=>PLATFORM_LABELS[key]&&typeof value==="string"&&value.trim());
  $("resultCount").textContent=entries.length+" drafts";
  for(const [key,value] of entries) {
    const card=document.createElement("article");card.className="output-card";
    const top=document.createElement("div");top.className="output-top";
    const title=document.createElement("strong");title.className="output-title";title.textContent=PLATFORM_LABELS[key];
    const copy=document.createElement("button");copy.className="copy-btn";copy.type="button";copy.textContent="Copy";
    copy.addEventListener("click",async()=>{
      try {await navigator.clipboard.writeText(area.value);copy.textContent="Copied";setTimeout(()=>copy.textContent="Copy",1200);}
      catch {showError("Clipboard access failed. Select the draft and copy it manually.");}
    });
    top.append(title,copy);
    const area=document.createElement("textarea");area.className="output-text";area.value=value;area.rows=Math.min(12,Math.max(5,Math.ceil(value.length/75)));area.setAttribute("aria-label",PLATFORM_LABELS[key]+" draft");
    card.append(top,area);root.append(card);
  }
  $("results").hidden=entries.length===0;
}
async function requestGeneration(payload) {
  if(!accountSession?.access_token) throw new Error("Sign in to generate drafts.");
  const response=await fetch(FUNCTION_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json",apikey:SUPABASE_KEY,Authorization:"Bearer "+accountSession.access_token},
    body:JSON.stringify(payload)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Generation failed ("+response.status+").");
  if(data.usage) accountUsage=data.usage;
  else await refreshUsage();
  renderAccount();
  const outputs=data.outputs||Object.fromEntries(["x_thread","linkedin_post","tiktok_hooks"].filter(k=>typeof data[k]==="string").map(k=>[k,data[k]]));
  renderOutputs(outputs);
  $("providerNote").hidden=!data.provider;
  if(data.provider) $("providerNote").textContent="Generated with "+data.provider+(data.fallbackUsed?" · primary provider unavailable":"");
  return data;
}
async function generateForSource(sourceMode="text",sourceUrl="") {
  clearError();$("providerNote").hidden=true;
  const platforms=selectedPlatforms();
  if(!platforms.length)return showError("Choose at least one platform.");
  if(sourceMode==="text"&&$("sourceText").value.trim().length<80)
    return showError("Add at least 80 characters of source text first.");
  setLoading(true,sourceMode==="youtube_video"?"Analyzing the YouTube video…":"Generating drafts…");
  try {
    await requestGeneration({
      text:sourceMode==="text"?$("sourceText").value.trim():"",
      title:$("sourceTitle").value.trim(),
      sourceUrl:sourceUrl||$("sourceUrl").value||"",
      sourceMode,
      platforms
    });
  } catch(error) {showError(error.message||"Could not generate drafts.");}
  finally {setLoading(false);}
}
$("generateBtn").addEventListener("click",()=>generateForSource());
$("analyzeVideoBtn").addEventListener("click",()=>{
  clearError();
  chrome.runtime.sendMessage({type:"HOOKENGINE_GET_ACTIVE_TAB"},tab=>{
    if(chrome.runtime.lastError)return showError(chrome.runtime.lastError.message);
    if(!tab?.ok||!tab.url)return showError(tab?.error||"Could not read the active tab.");
    let url;try{url=new URL(tab.url);}catch{}
    const host=url?.hostname?.toLowerCase().replace(/^www\./,"");
    if(!url||!["youtube.com","m.youtube.com","music.youtube.com","youtu.be"].includes(host))
      return showError("Open a public YouTube video first.");
    $("sourceUrl").value=tab.url;$("sourceTitle").value=tab.title||"YouTube video";
    generateForSource("youtube_video",tab.url);
  });
});
$("accountToggle").addEventListener("keydown",e=>{if(e.key==="Enter")$("accountToggle").click();});
initTheme();loadAccountSession();updateSourceMeta();updatePlatformCount();

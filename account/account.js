const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYWtud3V3aXVibHhvZ2NscWR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzkxNzQsImV4cCI6MjEwNzU1NTE3NH0.mlJayLmT_xCRfGjyrA7j8bqKQVhQrjhCBD5e3czVfr0";
const $ = id => document.getElementById(id);
const STORAGE_KEY = "hookengine-account-session";
let mode = "login";
let session = null;
let currentPlan = "free";

const THEME_KEY = "hookengine-account-theme";
function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  const icon = $("themeIcon");
  const label = $("themeLabel");
  const button = $("themeToggle");
  if (icon) icon.textContent = selected === "dark" ? "☀" : "☾";
  if (label) label.textContent = selected === "dark" ? "Light mode" : "Dark mode";
  if (button) {
    button.setAttribute("aria-label", selected === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.title = selected === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  const preferred = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(preferred);
}


function message(text, error=false) {
  const el = $("globalMessage");
  el.textContent = text;
  el.classList.toggle("error",error);
  el.hidden = !text;
  if (text) setTimeout(()=>{el.hidden=true},5000);
}
function authMessage(text,error=false) {
  $("authMessage").textContent=text;
  $("authMessage").classList.toggle("error",error);
}
function storeSession(value) {
  session=value;
  if(value) localStorage.setItem(STORAGE_KEY,JSON.stringify(value));
  else localStorage.removeItem(STORAGE_KEY);
}
async function api(path, options={}) {
  const headers={apikey:SUPABASE_KEY,"Content-Type":"application/json",...(options.headers||{})};
  if(session?.access_token) headers.Authorization="Bearer "+session.access_token;
  const response=await fetch(SUPABASE_URL+path,{...options,headers});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.msg||data.message||data.error_description||data.error||("Request failed ("+response.status+")"));
  return data;
}
async function restoreSession() {
  try {
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(!saved?.access_token) return false;
    session=saved;
    if(saved.expires_at && saved.expires_at*1000<Date.now()+30000) {
      if(!saved.refresh_token) {storeSession(null);return false;}
      const response=await fetch(SUPABASE_URL+"/auth/v1/token?grant_type=refresh_token",{
        method:"POST",headers:{apikey:SUPABASE_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({refresh_token:saved.refresh_token})
      });
      const next=await response.json().catch(()=>({}));
      if(!response.ok||!next.access_token) throw new Error("Session expired");
      next.expires_at=Math.floor(Date.now()/1000)+(next.expires_in||3600);
      storeSession(next);
    }
    await api("/auth/v1/user");
    return true;
  } catch {storeSession(null);return false;}
}
function setAuthMode(next) {
  mode=next;
  $("loginTab").classList.toggle("active",mode==="login");
  $("signupTab").classList.toggle("active",mode==="signup");
  $("authSubmit").innerHTML=(mode==="login"?"Sign in":"Create account")+" <span>→</span>";
  $("password").autocomplete=mode==="login"?"current-password":"new-password";
  authMessage("");
}
initTheme();
$("themeToggle").addEventListener("click",()=>{
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY,next); } catch {}
});
$("loginTab").addEventListener("click",()=>setAuthMode("login"));
$("signupTab").addEventListener("click",()=>setAuthMode("signup"));
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const button=$("authSubmit");button.disabled=true;authMessage("");
  const email=$("email").value.trim(),password=$("password").value;
  try {
    if(mode==="signup") {
      const result=await api("/auth/v1/signup?redirect_to="+encodeURIComponent("https://yazoniplay.github.io/HookEngine/account/"),{method:"POST",body:JSON.stringify({email,password})});
      if(!result.access_token) {
        authMessage("Account created. Check your email to confirm it, then sign in.");
        setAuthMode("login");
        return;
      }
      result.expires_at=Math.floor(Date.now()/1000)+(result.expires_in||3600);storeSession(result);
    } else {
      const result=await api("/auth/v1/token?grant_type=password",{method:"POST",body:JSON.stringify({email,password})});
      result.expires_at=Math.floor(Date.now()/1000)+(result.expires_in||3600);storeSession(result);
    }
    await showDashboard();
  } catch(err) {authMessage(err.message||"Could not sign in. Please try again.",true);}
  finally {button.disabled=false;}
});
$("signOutBtn").addEventListener("click",async()=>{
  try {if(session?.access_token) await api("/auth/v1/logout",{method:"POST"});}catch{}
  storeSession(null);showAuth();
});
function showAuth() {$("authView").hidden=false;$("dashboardView").hidden=true;$("signOutBtn").hidden=true;}
function utcStart(){const now=new Date();return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();}
function safe(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function timeLabel(value){return new Date(value).toLocaleString([], {dateStyle:"medium",timeStyle:"short"});}
async function showDashboard() {
  $("authView").hidden=true;$("dashboardView").hidden=false;$("signOutBtn").hidden=false;
  try {
    const user=await api("/auth/v1/user");
    $("accountEmail").textContent=user.email||"Signed in";
    const isAdmin = String(user.email || "").toLowerCase() === "yayazan.mahmoud@gmail.com" && !!user.email_confirmed_at;
    $("adminPlanControls").hidden = !isAdmin;
    if (isAdmin) $("adminPlanMessage").textContent = "";
    const [usage,history]=await Promise.all([
      api("/rest/v1/rpc/hookengine_my_usage",{method:"POST",body:"{}"}),
      api("/rest/v1/hookengine_generations?select=id,source_type,source_title,source_url,status,x_thread,linkedin_post,tiktok_hooks,outputs,selected_platforms,provider,error_message,created_at,completed_at,credits_reserved,input_tokens,output_tokens,latency_ms,estimated_provider_cost_usd,model,refunded_at&order=created_at.desc&limit=100")
    ]);
    currentPlan=usage.plan||"free";
    const used=Number(usage.daily_used)||0;
    const limit=Number(usage.daily_limit)||0;
    const credits=Number(usage.credits_balance)||0;
    const planLabels={free:"FREE PLAN",pro:"PRO PLAN",trial:"PRO TRIAL",lifetime:"LIFETIME PLAN"};
    $("planBadge").textContent=planLabels[currentPlan]||"FREE PLAN";
    $("planBadge").classList.toggle("pro",currentPlan!=="free");
    $("currentPlan").textContent={free:"Free",pro:"Pro",trial:"Pro Trial",lifetime:"Lifetime"}[currentPlan]||"Free";
    $("planDescription").textContent={
      free:`${Number(usage.credits_total)||0} credits each UTC week, with a maximum of ${Number(usage.daily_limit)||0} generations per day.`,
      pro:`${Number(usage.credits_total)||0} credits each UTC month, with a maximum of ${Number(usage.daily_limit)||0} generations per day.`,
      trial:`Pro features for 7 days or ${Number(usage.credits_total)||0} credits, whichever comes first.`,
      lifetime:`Pro features with ${Number(usage.credits_total)||0} credits refreshed each UTC month.`
    }[currentPlan]||"Your HookEngine plan.";
    $("planPrice").textContent={free:"€0",pro:(usage.price_minor==null?"Not configured":new Intl.NumberFormat("en-IE",{style:"currency",currency:usage.price_currency||"EUR"}).format(Number(usage.price_minor)/100)),trial:"€0",lifetime:(usage.price_minor==null?"Not configured":new Intl.NumberFormat("en-IE",{style:"currency",currency:usage.price_currency||"EUR"}).format(Number(usage.price_minor)/100))}[currentPlan]||"€0";
    $("planPricePeriod").textContent={free:"/ month",pro:(usage.price_minor==null?"billing not configured":"/ month"),trial:"/ 7 days",lifetime:(usage.price_minor==null?"pricing not configured":"")}[currentPlan]||"";
    const periodLabel=currentPlan==="free"?"UTC week":currentPlan==="trial"?"trial":"UTC month";
    const platformNames=(usage.platforms||[]).map(key=>({x_thread:"X",linkedin_post:"LinkedIn",tiktok_hooks:"TikTok",instagram_caption:"Instagram",threads_posts:"Threads",facebook_post:"Facebook"}[key]||key));
    const dashboardPerks={
      free:[`${Number(usage.credits_total)||0} credits each ${periodLabel}`,`Up to ${Number(usage.daily_limit)||0} generations per day`,platformNames.join(", ")+ " drafts",`${Number(usage.versions_per_generation)||1} version · ${Number(usage.regenerations_per_generation)||0} regeneration per source`,`${Number(usage.history_days)||7}-day generation history`],
      trial:[`${Number(usage.credits_total)||0} Pro trial credits · 7-day expiry`,`Up to ${Number(usage.daily_limit)||0} generations per day`,platformNames.join(", ")+ " drafts",`${Number(usage.versions_per_generation)||1} variations per generation`,usage.video_enabled?"Video analysis included":"Transcript generation available","Unlimited history during trial"],
      pro:[`${Number(usage.credits_total)||0} credits each ${periodLabel}`,`Up to ${Number(usage.daily_limit)||0} generations per day`,platformNames.join(", ")+ " drafts",`${Number(usage.versions_per_generation)||1} variations per generation`,usage.video_enabled?"Video analysis included":"Video analysis unavailable","Unlimited generation history"],
      lifetime:[`${Number(usage.credits_total)||0} credits each ${periodLabel}`,`Up to ${Number(usage.daily_limit)||0} generations per day`,platformNames.join(", ")+ " drafts",`${Number(usage.versions_per_generation)||1} variations per generation`,usage.video_enabled?"Video analysis included":"Video analysis unavailable","Unlimited generation history"]
    };
    const perksRoot=$("dashboardPerks");
    perksRoot.replaceChildren(...(dashboardPerks[currentPlan]||dashboardPerks.free).map(item=>{
      const li=document.createElement("li");
      const check=document.createElement("span");
      check.className="perk-check";
      check.textContent="✓";
      li.append(check,document.createTextNode(item));
      return li;
    }));
    $("usedCount").textContent=used;$("limitCount").textContent="/ "+limit;
    $("usageProgress").style.width=(limit>0?Math.min(100,used/limit*100):0)+"%";
    $("remainingText").textContent=credits+" credits left · "+Math.max(0,limit-used)+" generations left today";
    const totalTokens=Number(usage.total_tokens)||0;
    const inputTokens=Number(usage.total_input_tokens)||0;
    const outputTokens=Number(usage.total_output_tokens)||0;
    const consumed=Number(usage.credits_consumed)||0;
    const providerCost=Number(usage.estimated_provider_cost_usd)||0;
    const completed=Number(usage.total_generations)||0;
    const latency=Number(usage.average_latency_ms)||0;
    $("totalTokens").textContent=totalTokens.toLocaleString();
    $("tokenBreakdown").textContent=inputTokens.toLocaleString()+" input · "+outputTokens.toLocaleString()+" output";
    $("creditsConsumed").textContent=consumed.toLocaleString();
    $("providerCost").textContent="$"+providerCost.toFixed(5);
    const unpriced=Number(usage.unpriced_generations)||0;
    $("providerCostNote").textContent=unpriced
      ? "Partial · "+unpriced.toLocaleString()+" generations have no configured provider rate"
      : "USD · all recorded token usage has a configured rate";
    $("completedGenerations").textContent=completed.toLocaleString();
    $("averageLatency").textContent=latency ? "Average "+(latency/1000).toFixed(1)+"s per generation" : "No latency data yet";
    $("lifetimeSpots").textContent="Lifetime allocations are limited to "+(Number(usage.lifetime_limit)||50)+" total.";
    $("upgradeBtn").hidden=currentPlan==="pro"||currentPlan==="lifetime";
    $("billingMessage").textContent={
      free:`Free: ${Number(usage.credits_total)||0} weekly credits · ${Number(usage.daily_limit)||0} daily generations · ${Number(usage.history_days)||7}-day history.`,
      pro:`Pro: ${Number(usage.credits_total)||0} monthly credits · ${Number(usage.daily_limit)||0} daily generations.`,
      trial:"Trial ends "+(usage.trial_ends_at?timeLabel(usage.trial_ends_at):"after 7 days or when credits run out")+".",
      lifetime:`Lifetime: ${Number(usage.credits_total)||0} monthly credits · Pro features · ${Number(usage.lifetime_limit)||50} spots total.`
    }[currentPlan]||"Plan details unavailable.";
    renderHistory(history);
  } catch(err) {
    message("Could not load account data: "+err.message,true);
  }
}
function renderHistory(rows) {
  const root=$("historyList");
  if(!rows.length){root.innerHTML='<div class="empty-state">No generations yet. Open HookEngine in Chrome and create your first draft.</div>';return;}
  root.innerHTML=rows.map(row=>{
    const title=row.source_title||"Untitled source";
    const type=row.source_type==="youtube_video"?"YouTube video":"Article / text";
    const completed=row.status==="completed";
    const labels={x_thread:"X THREAD",linkedin_post:"LINKEDIN",tiktok_hooks:"TIKTOK HOOKS",instagram_caption:"INSTAGRAM",threads_posts:"THREADS",facebook_post:"FACEBOOK"};const saved=row.outputs&&typeof row.outputs==="object"?row.outputs:{x_thread:row.x_thread,linkedin_post:row.linkedin_post,tiktok_hooks:row.tiktok_hooks};const draft=Object.entries(saved).filter(([key,value])=>labels[key]&&value).map(([key,value])=>labels[key]+"\n"+value).join("\n\n────────────────────\n\n");
    const usageMeta=[];
    if(Number(row.credits_reserved)>0)usageMeta.push(Number(row.credits_reserved)+" credit"+(Number(row.credits_reserved)===1?"":"s")+(row.refunded_at?" refunded":""));
    const tokens=(Number(row.input_tokens)||0)+(Number(row.output_tokens)||0);
    if(tokens>0)usageMeta.push(tokens.toLocaleString()+" tokens");
    if(Number(row.latency_ms)>0)usageMeta.push((Number(row.latency_ms)/1000).toFixed(1)+"s");
    if(row.estimated_provider_cost_usd!==null&&row.estimated_provider_cost_usd!==undefined)usageMeta.push("~$"+Number(row.estimated_provider_cost_usd).toFixed(5));
    return '<article class="history-item"><div class="history-top"><div><div class="history-title">'+safe(title)+'</div><div class="history-meta"><span>'+safe(timeLabel(row.created_at))+'</span><span>·</span><span>'+safe(type)+'</span>'+(usageMeta.length?'<span>·</span><span>'+safe(usageMeta.join(" · "))+'</span>':'')+'</div></div><span class="type-pill">'+(completed?"Completed":safe(row.status))+'</span></div>'+
      (row.status==="failed"?'<div class="history-status" style="color:var(--danger)">Generation failed</div>':'')+
      (completed?'<div class="history-actions"><button class="small-button" data-preview="'+safe(row.id)+'">View drafts</button>'+(row.source_url?'<a class="small-button" href="'+safe(row.source_url)+'" target="_blank" rel="noopener">Open source ↗</a>':'')+'</div><pre id="preview-'+safe(row.id)+'" class="draft-preview">'+safe(draft)+'</pre>':'')+
      '</article>';
  }).join("");
  root.querySelectorAll("[data-preview]").forEach(button=>button.addEventListener("click",()=>{
    const panel=$("preview-"+button.dataset.preview);panel.classList.toggle("open");button.textContent=panel.classList.contains("open")?"Hide drafts":"View drafts";
  }));
}
$("refreshBtn").addEventListener("click",()=>showDashboard());
async function setAdminPlan(plan) {
  const buttons=["adminFreeBtn","adminTrialBtn","adminProBtn","adminLifetimeBtn"].map(id=>$(id));
  const status=$("adminPlanMessage");
  buttons.forEach(button=>button.disabled=true);
  status.textContent="Updating plan…";
  try {
    const result=await api("/functions/v1/hookengine-admin-plan",{method:"POST",body:JSON.stringify({plan})});
    if(!result.ok || result.plan!==plan) throw new Error(result.error||"The plan update could not be confirmed.");
    await showDashboard();
    $("adminPlanMessage").textContent=plan==="trial"
      ? "A fresh 7-day Pro trial with 40 credits has been granted."
      : plan==="lifetime"
        ? "Lifetime assigned. The 50-account cap was enforced."
        : "Plan switched to "+plan.charAt(0).toUpperCase()+plan.slice(1)+".";
  } catch(err) {
    status.textContent=err.message||"Could not update plan.";
  } finally {
    buttons.forEach(button=>button.disabled=false);
  }
}
$("adminFreeBtn").addEventListener("click",()=>setAdminPlan("free"));
$("adminTrialBtn").addEventListener("click",()=>setAdminPlan("trial"));
$("adminProBtn").addEventListener("click",()=>setAdminPlan("pro"));
$("adminLifetimeBtn").addEventListener("click",()=>setAdminPlan("lifetime"));
$("upgradeBtn").addEventListener("click",async()=>{
  const button=$("upgradeBtn");button.disabled=true;button.innerHTML="Opening secure checkout…";
  try {
    const result=await api("/functions/v1/hookengine-create-subscription",{method:"POST",body:JSON.stringify({})});
    if(!result.approvalUrl) throw new Error(result.error||"Checkout is not configured yet.");
    location.href=result.approvalUrl;
  } catch(err) {message(err.message||"Checkout is not ready yet.",true);button.disabled=false;button.innerHTML='Get Pro <span>→</span>';}
});
(async()=>{
  const params=new URLSearchParams(location.search);
  if(params.get("checkout")==="success") message("Payment approval returned. Your plan will update after PayPal confirms the subscription.");
  if(await restoreSession()) await showDashboard(); else showAuth();
})();

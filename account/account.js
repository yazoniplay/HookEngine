const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwYWtud3V3aXVibHhvZ2NscWR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NzkxNzQsImV4cCI6MjEwNzU1NTE3NH0.mlJayLmT_xCRfGjyrA7j8bqKQVhQrjhCBD5e3czVfr0";
const $ = id => document.getElementById(id);
const STORAGE_KEY = "hookengine-account-session";
let mode = "login";
let session = null;
let currentPlan = "free";

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
      const next=await api("/auth/v1/token?grant_type=refresh_token",{method:"POST",body:JSON.stringify({refresh_token:saved.refresh_token}),headers:{Authorization:""}});
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
$("loginTab").addEventListener("click",()=>setAuthMode("login"));
$("signupTab").addEventListener("click",()=>setAuthMode("signup"));
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const button=$("authSubmit");button.disabled=true;authMessage("");
  const email=$("email").value.trim(),password=$("password").value;
  try {
    if(mode==="signup") {
      const result=await api("/auth/v1/signup",{method:"POST",body:JSON.stringify({email,password})});
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
    const [subs,history]=await Promise.all([
      api("/rest/v1/hookengine_subscriptions?select=plan,status,current_period_end&limit=1"),
      api("/rest/v1/hookengine_generations?select=id,source_type,source_title,source_url,status,x_thread,linkedin_post,tiktok_hooks,error_message,created_at,completed_at&order=created_at.desc&limit=50")
    ]);
    const sub=subs[0]||{plan:"free",status:"inactive"};
    currentPlan=sub.status==="active"&&sub.plan==="pro"?"pro":"free";
    const today=utcStart();
    const used=history.filter(row=>row.created_at>=today&&["reserved","completed"].includes(row.status)).length;
    const limit=currentPlan==="pro"?100:5;
    $("planBadge").textContent=currentPlan==="pro"?"PRO PLAN":"FREE PLAN";
    $("planBadge").classList.toggle("pro",currentPlan==="pro");
    $("currentPlan").textContent=currentPlan==="pro"?"Pro":"Free";
    $("planDescription").textContent=currentPlan==="pro"?"More room for daily content production.":"A simple daily allowance to get started.";
    $("planPrice").textContent=currentPlan==="pro"?"€4.99":"€0";
    $("usedCount").textContent=used;$("limitCount").textContent="/ "+limit;
    $("usageProgress").style.width=Math.min(100,used/limit*100)+"%";
    $("remainingText").textContent=Math.max(0,limit-used)+" generations left today";
    $("upgradeBtn").hidden=currentPlan==="pro";
    $("billingMessage").textContent=currentPlan==="pro"?(sub.current_period_end?"Current period ends "+timeLabel(sub.current_period_end):"Pro membership active."): "Pro: 100 generations per day · €4.99/month.";
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
    const draft=[["X THREAD",row.x_thread],["LINKEDIN",row.linkedin_post],["TIKTOK HOOKS",row.tiktok_hooks]].filter(x=>x[1]).map(x=>x[0]+"\n"+x[1]).join("\n\n────────────────────\n\n");
    return '<article class="history-item"><div class="history-top"><div><div class="history-title">'+safe(title)+'</div><div class="history-meta"><span>'+safe(timeLabel(row.created_at))+'</span><span>·</span><span>'+safe(type)+'</span></div></div><span class="type-pill">'+(completed?"Completed":safe(row.status))+'</span></div>'+
      (row.status==="failed"?'<div class="history-status" style="color:var(--danger)">Generation failed</div>':'')+
      (completed?'<div class="history-actions"><button class="small-button" data-preview="'+safe(row.id)+'">View drafts</button>'+(row.source_url?'<a class="small-button" href="'+safe(row.source_url)+'" target="_blank" rel="noopener">Open source ↗</a>':'')+'</div><pre id="preview-'+safe(row.id)+'" class="draft-preview">'+safe(draft)+'</pre>':'')+
      '</article>';
  }).join("");
  root.querySelectorAll("[data-preview]").forEach(button=>button.addEventListener("click",()=>{
    const panel=$("preview-"+button.dataset.preview);panel.classList.toggle("open");button.textContent=panel.classList.contains("open")?"Hide drafts":"View drafts";
  }));
}
$("refreshBtn").addEventListener("click",()=>showDashboard());
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

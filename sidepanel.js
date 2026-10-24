const $ = (id) => document.getElementById(id);
const sourceText = $("sourceText");
const generateBtn = $("generateBtn");
function updateCount() { $("charCount").textContent = \`\${sourceText.value.length.toLocaleString()} characters\`; }
sourceText.addEventListener("input", updateCount);
$("extractBtn").addEventListener("click", () => {
  $("errorMessage").hidden = true; $("extractBtn").disabled = true;
  chrome.runtime.sendMessage({type:"HOOKENGINE_EXTRACT_ACTIVE_TAB"}, response => {
    $("extractBtn").disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    if (!response?.ok) return showError(response?.error || "Could not extract page content.");
    if (response.needsTranscript) {
      $("sourceLabel").textContent = "Transcript not found";
      showError("YouTube did not expose its transcript. Open YouTube’s “Show transcript” panel, then click Read current tab again.");
      if (response.text) sourceText.value = response.text;
    } else {
      sourceText.value=response.text||""; $("sourceTitle").value=response.title||""; $("sourceUrl").value=response.url||"";
      $("sourceLabel").textContent=response.sourceType==="youtube-transcript"?"YouTube transcript":"Page content";
    }
    updateCount();
  });
});
function showError(message){$("errorMessage").textContent=message;$("errorMessage").hidden=false;}
function setLoading(loading){generateBtn.disabled=loading;$("loading").hidden=!loading;$("generateIcon").textContent=loading?"":"✦";$("generateLabel").textContent=loading?"Generating…":"Generate content";}
async function getApiUrl(){const stored=await chrome.storage.sync.get({apiUrl:"http://localhost:3000"});return stored.apiUrl.replace(/\/+$/,"");}
generateBtn.addEventListener("click",async()=>{
  $("errorMessage").hidden=true;
  if(sourceText.value.trim().length<80)return showError("Add at least 80 characters of source text before generating.");
  setLoading(true);
  try{
    const apiUrl=await getApiUrl();const {access_token}=await chrome.storage.local.get("access_token");
    const response=await fetch(\`\${apiUrl}/api/generate\`,{method:"POST",headers:{"Content-Type":"application/json",...(access_token?{Authorization:\`Bearer \${access_token}\`}:{})},body:JSON.stringify({text:sourceText.value.trim(),title:$("sourceTitle").value.trim(),sourceUrl:$("sourceUrl").value||""})});
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||\`Request failed (\${response.status})\`);
    for(const key of ["x_thread","linkedin_post","tiktok_hooks"]){if(typeof data[key]!=="string")throw new Error("The server returned an invalid response. Please try again.");$(key).value=data[key];}
    $("results").hidden=false;
  }catch(error){showError(error.message||"Could not connect to HookEngine. Check your backend URL and server status.");}
  finally{setLoading(false);}
});
document.querySelectorAll("[data-copy]").forEach(button=>button.addEventListener("click",async()=>{
  const value=$(button.dataset.copy).value;if(!value)return;
  try{await navigator.clipboard.writeText(value);button.textContent="Copied ✓";setTimeout(()=>{button.textContent="Copy ↗";},1300);}
  catch{showError("Clipboard access failed. Select the output and copy it manually.");}
}));
$("settingsBtn").addEventListener("click",async()=>{const {apiUrl="http://localhost:3000"}=await chrome.storage.sync.get("apiUrl");$("apiUrl").value=apiUrl;$("settingsDialog").showModal();});
$("settingsForm").addEventListener("submit",async event=>{
  if(event.submitter?.value==="cancel")return;event.preventDefault();
  const apiUrl=$("apiUrl").value.trim().replace(/\/+$/,"");
  if(!/^https?:\/\//i.test(apiUrl))return showError("Enter a valid backend URL.");
  await chrome.storage.sync.set({apiUrl});$("settingsDialog").close();
});
updateCount();
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL = Deno.env.get("SUPABASE_URL") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET") || "";
const PLAN_ID = Deno.env.get("PAYPAL_PRO_PLAN_ID") || "";
const MODE = (Deno.env.get("PAYPAL_MODE") || "sandbox").toLowerCase();
const ORIGIN = "https://yazoniplay.github.io";
const headers = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };
function reply(status:number, body:Record<string,unknown>) { return new Response(JSON.stringify(body), {status,headers}); }
async function paypalToken() {
  const base = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const response = await fetch(base + "/v1/oauth2/token", { method:"POST", headers:{Authorization:"Basic "+btoa(CLIENT_ID+":"+CLIENT_SECRET),"Content-Type":"application/x-www-form-urlencoded"}, body:"grant_type=client_credentials" });
  if(!response.ok) throw new Error("PayPal authentication failed. Check the merchant credentials.");
  return {base,token:(await response.json()).access_token as string};
}
Deno.serve(async (req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers});
  if(req.method!=="POST") return reply(405,{error:"Method not allowed."});
  if(req.headers.get("origin")!==ORIGIN) return reply(403,{error:"Origin not allowed."});
  const auth=req.headers.get("authorization")||"";
  const token=auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if(!token||!URL||!ANON) return reply(401,{error:"Sign in to your HookEngine account first."});
  const userResponse=await fetch(URL+"/auth/v1/user",{headers:{apikey:ANON,Authorization:"Bearer "+token}});
  if(!userResponse.ok) return reply(401,{error:"Your session expired. Sign in again."});
  const user=await userResponse.json();
  if(!user?.id) return reply(401,{error:"Could not verify your account."});
  if(!CLIENT_ID||!CLIENT_SECRET||!PLAN_ID||!SERVICE) return reply(503,{error:"Pro checkout is not configured yet. The merchant must finish PayPal setup first."});
  if(MODE!=="sandbox"&&MODE!=="live") return reply(503,{error:"PayPal mode must be sandbox or live."});
  try {
    const {base,token:paypalAccessToken}=await paypalToken();
    const response=await fetch(base+"/v1/billing/subscriptions",{
      method:"POST",
      headers:{Authorization:"Bearer "+paypalAccessToken,"Content-Type":"application/json","PayPal-Request-Id":crypto.randomUUID()},
      body:JSON.stringify({
        plan_id:PLAN_ID,
        custom_id:user.id,
        application_context:{
          brand_name:"HookEngine",
          user_action:"SUBSCRIBE_NOW",
          shipping_preference:"NO_SHIPPING",
          return_url:ORIGIN+"/HookEngine/account/?checkout=success",
          cancel_url:ORIGIN+"/HookEngine/account/?checkout=cancel"
        }
      })
    });
    const subscription=await response.json().catch(()=>({}));
    if(!response.ok){
      console.error("PayPal subscription creation failed:",response.status,JSON.stringify(subscription).slice(0,500));
      return reply(502,{error:"PayPal could not start checkout. Check the configured Pro billing plan."});
    }
    const approvalUrl=(subscription.links||[]).find((link:any)=>link.rel==="approve")?.href;
    if(!subscription.id||!approvalUrl) return reply(502,{error:"PayPal did not return an approval link."});
    const saved=await fetch(URL+"/rest/v1/hookengine_subscriptions?on_conflict=user_id",{
      method:"POST",
      headers:{apikey:SERVICE,Authorization:"Bearer "+SERVICE,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify({user_id:user.id,plan:"pro",status:"inactive",provider:"paypal",provider_subscription_id:subscription.id,updated_at:new Date().toISOString()})
    });
    if(!saved.ok){console.error("Could not save pending subscription:",saved.status,(await saved.text()).slice(0,300));return reply(502,{error:"Checkout started but account setup failed. Contact support before paying again."});}
    return reply(200,{approvalUrl,subscriptionId:subscription.id});
  } catch(error) {
    console.error("Checkout error:",error);
    return reply(502,{error:"Could not start Pro checkout. Try again later."});
  }
});
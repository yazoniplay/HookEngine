import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL=Deno.env.get("SUPABASE_URL")||"";
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const CLIENT_ID=Deno.env.get("PAYPAL_CLIENT_ID")||"";
const CLIENT_SECRET=Deno.env.get("PAYPAL_CLIENT_SECRET")||"";
const WEBHOOK_ID=Deno.env.get("PAYPAL_WEBHOOK_ID")||"";
const MODE=(Deno.env.get("PAYPAL_MODE")||"sandbox").toLowerCase();
function reply(status:number,body:Record<string,unknown>){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});}
async function paypalToken(){
 const base=MODE==="live"?"https://api-m.paypal.com":"https://api-m.sandbox.paypal.com";
 const response=await fetch(base+"/v1/oauth2/token",{method:"POST",headers:{Authorization:"Basic "+btoa(CLIENT_ID+":"+CLIENT_SECRET),"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
 if(!response.ok) throw new Error("PayPal authentication failed");
 return {base,token:(await response.json()).access_token as string};
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST") return reply(405,{error:"Method not allowed."});
 if(!URL||!SERVICE||!CLIENT_ID||!CLIENT_SECRET||!WEBHOOK_ID) return reply(503,{error:"Webhook configuration is incomplete."});
 try{
  const event=await req.json();
  const {base,token}=await paypalToken();
  const verifyResponse=await fetch(base+"/v1/notifications/verify-webhook-signature",{
   method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
   body:JSON.stringify({
    auth_algo:req.headers.get("paypal-auth-algo"),
    cert_url:req.headers.get("paypal-cert-url"),
    transmission_id:req.headers.get("paypal-transmission-id"),
    transmission_sig:req.headers.get("paypal-transmission-sig"),
    transmission_time:req.headers.get("paypal-transmission-time"),
    webhook_id:WEBHOOK_ID,
    webhook_event:event
   })
  });
  const verification=await verifyResponse.json().catch(()=>({}));
  if(!verifyResponse.ok||verification.verification_status!=="SUCCESS") return reply(400,{error:"Invalid PayPal webhook signature."});
  const type=String(event.event_type||"");
  const resource=event.resource||{};
  const subscriptionId=String(resource.id||resource.billing_agreement_id||"");
  if(!subscriptionId) return reply(200,{received:true,ignored:true});
  let status:string|null=null,plan:string|null=null;
  if(type==="BILLING.SUBSCRIPTION.ACTIVATED"||type==="BILLING.SUBSCRIPTION.RE-ACTIVATED"){status="active";plan="pro";}
  else if(type==="BILLING.SUBSCRIPTION.CANCELLED"||type==="BILLING.SUBSCRIPTION.EXPIRED"){status="cancelled";plan="free";}
  else if(type==="BILLING.SUBSCRIPTION.SUSPENDED"||type==="BILLING.SUBSCRIPTION.PAYMENT.FAILED"){status="past_due";plan="free";}
  else return reply(200,{received:true,ignored:true});
  const next=resource.billing_info?.next_billing_time;
  const patch:Record<string,unknown>={status,plan,updated_at:new Date().toISOString()};
  if(next) patch.current_period_end=next;
  const updated=await fetch(URL+"/rest/v1/hookengine_subscriptions?provider_subscription_id=eq."+encodeURIComponent(subscriptionId),{
   method:"PATCH",headers:{apikey:SERVICE,Authorization:"Bearer "+SERVICE,"Content-Type":"application/json","Prefer":"return=minimal"},body:JSON.stringify(patch)
  });
  if(!updated.ok){console.error("Subscription update failed:",updated.status,(await updated.text()).slice(0,300));return reply(500,{error:"Could not update subscription."});}
  return reply(200,{received:true,updated:true});
 }catch(error){console.error("PayPal webhook error:",error);return reply(500,{error:"Webhook processing failed."});}
});
import { ALL_PLATFORMS, FREE_PLATFORMS } from "./config.js";
// Shared customer-facing plan catalog. Keep aligned with database entitlements.
export const PLAN_CATALOG = Object.freeze({
 free:Object.freeze({label:"Free",billingInterval:"weekly",credits:5,dailyGenerations:3,voiceEnabled:false,videoEnabled:false,isActive:true,trialCreditLimit:null,platforms:FREE_PLATFORMS,historyDays:7,variations:1,regenerationsPerSource:1,trialDays:null,lifetimeSpots:null,priceMinor:0,currency:"EUR",features:Object.freeze(["5 credits per UTC week","Up to 3 generations per UTC day","X threads, LinkedIn posts and TikTok hooks","7-day generation history","1 version and 1 regeneration per source","Article/text: 1 credit · YouTube video: 5 credits"])}),
 trial:Object.freeze({label:"Pro Trial",billingInterval:"trial",credits:40,dailyGenerations:30,voiceEnabled:true,videoEnabled:true,isActive:true,trialCreditLimit:40,platforms:ALL_PLATFORMS,historyDays:null,variations:3,regenerationsPerSource:null,trialDays:7,lifetimeSpots:null,priceMinor:0,currency:"EUR",features:Object.freeze(["40 credits over 7 days","Pro features for the trial period","Up to 30 generations per UTC day","All six supported platforms","3 variations per generation","Unlimited generation history during the trial"])}),
 pro:Object.freeze({label:"Pro",billingInterval:"monthly",credits:300,dailyGenerations:30,voiceEnabled:true,videoEnabled:true,isActive:true,trialCreditLimit:null,platforms:ALL_PLATFORMS,historyDays:null,variations:3,regenerationsPerSource:null,trialDays:null,lifetimeSpots:null,priceMinor:499,currency:"EUR",features:Object.freeze(["300 credits per UTC month","Up to 30 generations per UTC day","All six supported platforms","3 variations per generation","Unlimited generation history","Article/text: 1 credit · YouTube video: 5 credits · regeneration: 1 credit"])}),
 lifetime:Object.freeze({label:"Lifetime",billingInterval:"monthly",credits:150,dailyGenerations:30,voiceEnabled:true,videoEnabled:true,isActive:true,trialCreditLimit:null,platforms:ALL_PLATFORMS,historyDays:null,variations:3,regenerationsPerSource:null,trialDays:null,lifetimeSpots:50,priceMinor:null,currency:"EUR",features:Object.freeze(["150 credits per UTC month","Pro features across all six platforms","3 variations per generation","Unlimited generation history","50 lifetime spots in total","Price has not been set"])})
});
export const CREDIT_COSTS=Object.freeze({article:1,youtubeVideo:5,regeneration:1,videoRegeneration:5});
export const PLATFORM_LABELS=Object.freeze({x_thread:"X",linkedin_post:"LinkedIn",tiktok_hooks:"TikTok",instagram_caption:"Instagram",threads_posts:"Threads",facebook_post:"Facebook"});
export function formatPlanPrice(key){const plan=PLAN_CATALOG[key];if(!plan||plan.priceMinor===null)return "Price not set";return new Intl.NumberFormat("en-IE",{style:"currency",currency:plan.currency,maximumFractionDigits:2}).format(plan.priceMinor/100);}
export function formatPlanPeriod(key){return ({weekly:"",monthly:"/ month",trial:"/ 7 days",none:""})[PLAN_CATALOG[key]?.billingInterval]??"";}
export function planSummary(key){
 const plan=PLAN_CATALOG[key]||PLAN_CATALOG.free;
 if(key==="free")return plan.credits+" credits per UTC week · up to "+plan.dailyGenerations+" generations per UTC day · "+plan.platforms.length+" platforms · "+plan.historyDays+"-day history";
 if(key==="trial")return plan.credits+" credits over "+plan.trialDays+" days · Pro features · up to "+plan.dailyGenerations+" generations per UTC day";
 if(key==="pro")return plan.credits+" credits per UTC month · up to "+plan.dailyGenerations+" generations per UTC day · "+plan.platforms.length+" platforms · "+plan.variations+" variations";
 if(key==="lifetime")return plan.credits+" credits per UTC month · "+plan.lifetimeSpots+" total spots · "+formatPlanPrice(key).toLowerCase();
 return plan.label;
}
export function planFeatures(key){return [...(PLAN_CATALOG[key]||PLAN_CATALOG.free).features];}

import { PLAN_CATALOG, formatPlanPrice, formatPlanPeriod, planSummary, planFeatures } from "./extension/plans.js";
for(const node of document.querySelectorAll("[data-plan-summary]"))node.textContent=planSummary(node.dataset.planSummary);
for(const node of document.querySelectorAll("[data-plan-price]"))node.textContent=formatPlanPrice(node.dataset.planPrice);
for(const node of document.querySelectorAll("[data-plan-period]"))node.textContent=formatPlanPeriod(node.dataset.planPeriod);
for(const node of document.querySelectorAll("[data-plan-daily]"))node.textContent=String(PLAN_CATALOG[node.dataset.planDaily].dailyGenerations);
for(const node of document.querySelectorAll("[data-plan-features]"))node.replaceChildren(...planFeatures(node.dataset.planFeatures).map(feature=>{const li=document.createElement("li");li.textContent=feature;return li;}));

const schemaNode=document.querySelector('script[type="application/ld+json"]');
if(schemaNode){
  const schema=JSON.parse(schemaNode.textContent);
  schema.offers=["free","pro"].map(key=>({ "@type":"Offer", name:PLAN_CATALOG[key].label, price:String(PLAN_CATALOG[key].priceMinor/100), priceCurrency:PLAN_CATALOG[key].currency }));
  schemaNode.textContent=JSON.stringify(schema);
}

import { validatePayPalProPlanId } from "./plan-validation.ts";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET") || "";
const WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID") || "";
const MODE = (Deno.env.get("PAYPAL_MODE") || "sandbox").toLowerCase();
const PAYPAL_PRO_PLAN_ID = Deno.env.get("PAYPAL_PRO_PLAN_ID") || "";

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function paypalToken() {
  const base = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const response = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(CLIENT_ID + ":" + CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error("PayPal authentication failed.");
  return { base, token: (await response.json()).access_token as string };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "Method not allowed." });
  if (!URL || !SERVICE || !CLIENT_ID || !CLIENT_SECRET || !WEBHOOK_ID) {
    return reply(503, { error: "Webhook configuration is incomplete." });
  }
  if (MODE !== "sandbox" && MODE !== "live") {
    return reply(503, { error: "PayPal mode must be sandbox or live." });
  }

  try {
    const event = await req.json().catch(() => null);
    if (!event || typeof event !== "object") return reply(400, { error: "Invalid webhook payload." });

    const { base, token } = await paypalToken();
    const verifyResponse = await fetch(base + "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: req.headers.get("paypal-auth-algo"),
        cert_url: req.headers.get("paypal-cert-url"),
        transmission_id: req.headers.get("paypal-transmission-id"),
        transmission_sig: req.headers.get("paypal-transmission-sig"),
        transmission_time: req.headers.get("paypal-transmission-time"),
        webhook_id: WEBHOOK_ID,
        webhook_event: event,
      }),
    });
    const verification = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || verification.verification_status !== "SUCCESS") {
      return reply(400, { error: "Invalid PayPal webhook signature." });
    }

    const type = String(event.event_type || "");
    const supported = [
      "BILLING.SUBSCRIPTION.ACTIVATED",
      "BILLING.SUBSCRIPTION.RE-ACTIVATED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.EXPIRED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    ];
    if (!supported.includes(type)) return reply(200, { received: true, ignored: true });

    if (type === "BILLING.SUBSCRIPTION.ACTIVATED" || type === "BILLING.SUBSCRIPTION.RE-ACTIVATED") {
      const planCheck = validatePayPalProPlanId(resource, PAYPAL_PRO_PLAN_ID);
      if (!planCheck.ok) {
        if (planCheck.reason === "not_configured") {
          return reply(503, { error: "PayPal Pro plan ID is not configured; subscription activation is disabled." });
        }
        return reply(400, { error: "PayPal subscription uses an unexpected plan ID." });
      }
    }

    const eventId = String(event.id || "");
    const resource = event.resource || {};
    const subscriptionId = String(resource.id || resource.billing_agreement_id || "");
    const eventTime = new Date(String(event.create_time || ""));
    if (!eventId || !subscriptionId || !Number.isFinite(eventTime.getTime())) {
      return reply(400, { error: "Webhook event is missing its ID, subscription ID or timestamp." });
    }

    const nextBilling = resource.billing_info?.next_billing_time;
    const nextBillingTime = typeof nextBilling === "string" && Number.isFinite(Date.parse(nextBilling))
      ? new Date(nextBilling).toISOString()
      : null;

    const appliedResponse = await fetch(URL + "/rest/v1/rpc/hookengine_apply_paypal_event", {
      method: "POST",
      headers: {
        apikey: SERVICE,
        Authorization: "Bearer " + SERVICE,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_event_id: eventId,
        p_event_type: type,
        p_subscription_id: subscriptionId,
        p_event_time: eventTime.toISOString(),
        p_next_billing_time: nextBillingTime,
      }),
    });
    const result = await appliedResponse.json().catch(() => null);
    if (!appliedResponse.ok || !result) {
      console.error("PayPal event application failed:", appliedResponse.status, JSON.stringify(result).slice(0, 300));
      return reply(500, { error: "Could not apply the subscription event." });
    }
    if (result.reason === "unknown_subscription") {
      return reply(503, { error: "Subscription is not registered yet. PayPal may retry this event." });
    }
    if (result.reason === "invalid_event" || result.reason === "unsupported_event") {
      return reply(400, { error: "Unsupported or invalid subscription event." });
    }
    return reply(200, { received: true, ...result });
  } catch (error) {
    console.error("PayPal webhook error:", error);
    return reply(500, { error: "Webhook processing failed." });
  }
});

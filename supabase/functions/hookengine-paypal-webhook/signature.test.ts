import { assertEquals } from "jsr:@std/assert";
import { verifyPayPalWebhookSignature } from "./signature.ts";

const headers = new Headers({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/cert",
  "paypal-transmission-id": "transmission-123",
  "paypal-transmission-sig": "forged-or-test-signature",
  "paypal-transmission-time": "2026-10-31T09:00:00Z",
});
const input = {
  base: "https://api-m.sandbox.paypal.com",
  accessToken: "test-access-token",
  webhookId: "test-webhook-id",
  headers,
  event: { id: "WH-TEST", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: "I-TEST" } },
};

Deno.test("forged signature is rejected when PayPal verification returns FAILURE", async () => {
  const submitted: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assertEquals(String(url), input.base + "/v1/notifications/verify-webhook-signature");
    submitted.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ verification_status: "FAILURE" }), { status: 200 });
  };
  const accepted = await verifyPayPalWebhookSignature(input, fakeFetch);
  assertEquals(accepted, false);
  assertEquals(submitted[0]?.transmission_id, "transmission-123");
  assertEquals(submitted[0]?.transmission_sig, "forged-or-test-signature");
  assertEquals(submitted[0]?.webhook_id, "test-webhook-id");
  assertEquals(submitted[0]?.webhook_event, input.event);
});

Deno.test("valid signature is accepted only when PayPal returns SUCCESS", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 });
  assertEquals(await verifyPayPalWebhookSignature(input, fakeFetch), true);
});

Deno.test("missing PayPal transmission headers fail closed without an API call", async () => {
  let called = false;
  const fakeFetch: typeof fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  assertEquals(await verifyPayPalWebhookSignature({ ...input, headers: new Headers() }, fakeFetch), false);
  assertEquals(called, false);
});

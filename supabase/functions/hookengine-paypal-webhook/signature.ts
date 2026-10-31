export interface PayPalSignatureInput {
  base: string;
  accessToken: string;
  webhookId: string;
  headers: Headers;
  event: Record<string, unknown>;
}

export async function verifyPayPalWebhookSignature(
  input: PayPalSignatureInput,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const authAlgo = input.headers.get("paypal-auth-algo");
  const certUrl = input.headers.get("paypal-cert-url");
  const transmissionId = input.headers.get("paypal-transmission-id");
  const transmissionSig = input.headers.get("paypal-transmission-sig");
  const transmissionTime = input.headers.get("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime || !input.webhookId) {
    return false;
  }
  try {
    const response = await fetchImpl(input.base + "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: { Authorization: "Bearer " + input.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: input.webhookId,
        webhook_event: input.event,
      }),
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}

# HookEngine PayPal Sandbox Setup

Use sandbox credentials only while testing. Do not put PayPal credentials in frontend files, GitHub commits, or chat messages.

## 1. Create sandbox credentials and a subscription plan

1. Open the PayPal Developer Dashboard: https://developer.paypal.com/dashboard/
2. Switch to **Sandbox**.
3. Create or select a sandbox REST app and copy its **Client ID** and **Secret**.
4. In the sandbox business account, create a subscription product and a monthly billing plan for HookEngine Pro at **EUR 4.99/month**. Copy the sandbox plan ID.
5. Create a webhook for the sandbox REST app using this URL:
   `https://ppaknwuwiublxogclqdw.supabase.co/functions/v1/hookengine-paypal-webhook`
6. Subscribe to these events:
   - `BILLING.SUBSCRIPTION.ACTIVATED`
   - `BILLING.SUBSCRIPTION.RE-ACTIVATED`
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `BILLING.SUBSCRIPTION.EXPIRED`
   - `BILLING.SUBSCRIPTION.SUSPENDED`
   - `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
7. Copy the webhook ID.

## 2. Configure Supabase Edge Function secrets

In Supabase Dashboard → Project Settings → Edge Functions / Secrets (the label may vary), set:

- `PAYPAL_MODE=sandbox`
- `PAYPAL_CLIENT_ID=<sandbox app client ID>`
- `PAYPAL_CLIENT_SECRET=<sandbox app secret>`
- `PAYPAL_PRO_PLAN_ID=<sandbox monthly plan ID>`
- `PAYPAL_WEBHOOK_ID=<sandbox webhook ID>`

The existing Supabase service secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`) must also remain configured. Never publish the service-role key.

The checkout and webhook functions both read `PAYPAL_MODE`. The checkout code defaults to sandbox when the variable is absent, but explicitly setting it is safer.

## 3. Test the full flow

1. Open the HookEngine account page and sign in with a test account.
2. Click **Get Pro**. PayPal should open a sandbox approval page, not a live checkout.
3. Approve using a **sandbox personal test account** created in the Developer Dashboard—not a real PayPal account.
4. Confirm the webhook delivery succeeds and the HookEngine account changes to Pro only after PayPal confirms activation.
5. Test cancellation and failure events too. A return to the account page alone does not prove the subscription is active.

## Important

- Sandbox and live use separate apps, plan IDs, and webhook IDs. Do not mix credentials between them.
- Do not set `PAYPAL_MODE=live` until sandbox checkout, webhook verification, activation, cancellation, and quota enforcement have all been tested.
- This guide does not configure the secrets automatically; an authorized project owner must add them in Supabase.

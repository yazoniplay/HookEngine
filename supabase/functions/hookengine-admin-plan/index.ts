import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ADMIN_EMAIL = "yayazan.mahmoud@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const token = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Sign in with the admin account to continue." }, 401);
  }

  const authResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
  });
  if (!authResponse.ok) return json({ error: "Your session is invalid. Sign in again." }, 401);
  const user = await authResponse.json().catch(() => null);

  if (typeof user?.id !== "string" ||
      String(user.email || "").toLowerCase() !== ADMIN_EMAIL ||
      !user.email_confirmed_at) {
    return json({ error: "This account is not authorized to manage plans." }, 403);
  }

  let body: { plan?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const allowedPlans = ["free", "pro", "trial", "lifetime"];
  if (!allowedPlans.includes(String(body?.plan))) {
    return json({ error: "Choose Free, Pro, Trial or Lifetime." }, 400);
  }

  const update = await fetch(SUPABASE_URL + "/rest/v1/rpc/hookengine_admin_set_plan", {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_user_id: user.id, p_plan: body.plan }),
  });

  const result = await update.json().catch(() => null);
  if (!update.ok || !result || result.ok === false || result.assigned === false) {
    console.error("Admin plan update failed:", update.status, JSON.stringify(result).slice(0, 300));
    const reason = result?.reason === "sold_out"
      ? "All 50 Lifetime spots have been claimed."
      : "Could not update the plan. Please try again.";
    return json({ error: reason, ...result }, result?.reason === "sold_out" ? 409 : 500);
  }

  return json({ ok: true, plan: body.plan, ...result });
});

export interface AdminPlanConfig {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  adminEmail: string;
}

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

export function createAdminPlanHandler(config: AdminPlanConfig, fetchImpl: typeof fetch = fetch) {
  async function writeAudit(input: {
    actorUserId?: string | null;
    actorEmail?: string | null;
    requestedPlan?: string | null;
    outcome: string;
    httpStatus: number;
    details?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!config.supabaseUrl || !config.serviceRoleKey) return false;
    try {
      const response = await fetchImpl(config.supabaseUrl + "/rest/v1/hookengine_admin_audit", {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: "Bearer " + config.serviceRoleKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          actor_user_id: input.actorUserId || null,
          actor_email: input.actorEmail || null,
          target_user_id: input.actorUserId || null,
          action: "set_plan",
          requested_plan: input.requestedPlan || null,
          outcome: input.outcome,
          http_status: input.httpStatus,
          details: input.details || {},
        }),
      });
      if (!response.ok) console.error("Admin audit write failed:", response.status, (await response.text()).slice(0, 200));
      return response.ok;
    } catch (error) {
      console.error("Admin audit write failed:", String(error).slice(0, 200));
      return false;
    }
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") {
      await writeAudit({ outcome: "rejected_method", httpStatus: 405, details: { method: req.method } });
      return json({ error: "Method not allowed." }, 405);
    }

    const token = (req.headers.get("authorization") || "").match(/^Bearer\\s+(.+)$/i)?.[1];
    if (!token || !config.supabaseUrl || !config.anonKey || !config.serviceRoleKey) {
      await writeAudit({ outcome: "rejected_missing_token_or_config", httpStatus: 401 });
      return json({ error: "Sign in with the admin account to continue." }, 401);
    }

    const authResponse = await fetchImpl(config.supabaseUrl + "/auth/v1/user", {
      headers: { apikey: config.anonKey, Authorization: "Bearer " + token },
    });
    if (!authResponse.ok) {
      await writeAudit({ outcome: "rejected_invalid_session", httpStatus: 401 });
      return json({ error: "Your session is invalid. Sign in again." }, 401);
    }
    const user = await authResponse.json().catch(() => null);

    if (typeof user?.id !== "string" ||
        String(user.email || "").toLowerCase() !== config.adminEmail.toLowerCase() ||
        !user.email_confirmed_at) {
      await writeAudit({
        actorUserId: typeof user?.id === "string" ? user.id : null,
        actorEmail: typeof user?.email === "string" ? user.email : null,
        outcome: "rejected_not_admin",
        httpStatus: 403,
      });
      return json({ error: "This account is not authorized to manage plans." }, 403);
    }

    let body: { plan?: unknown };
    try { body = await req.json(); } catch {
      await writeAudit({
        actorUserId: user.id,
        actorEmail: user.email,
        outcome: "rejected_invalid_body",
        httpStatus: 400,
      });
      return json({ error: "Invalid request body." }, 400);
    }
    const allowedPlans = ["free", "pro", "trial"];
    if (!allowedPlans.includes(String(body?.plan))) {
      await writeAudit({
        actorUserId: user.id,
        actorEmail: user.email,
        requestedPlan: typeof body?.plan === "string" ? body.plan : null,
        outcome: "rejected_invalid_or_lifetime_plan",
        httpStatus: 400,
      });
      return json({ error: "Choose Free, Pro or Trial. Lifetime spots are reserved for eligible customers." }, 400);
    }

    const auditReady = await writeAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      requestedPlan: String(body.plan),
      outcome: "attempted",
      httpStatus: 202,
    });
    if (!auditReady) {
      return json({ error: "Admin audit service is unavailable; no plan change was made." }, 503);
    }

    const update = await fetchImpl(config.supabaseUrl + "/rest/v1/rpc/hookengine_admin_set_plan", {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: "Bearer " + config.serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: user.id, p_plan: body.plan }),
    });

    const result = await update.json().catch(() => null);
    if (!update.ok || !result || result.ok === false || result.assigned === false) {
      await writeAudit({
        actorUserId: user.id,
        actorEmail: user.email,
        requestedPlan: String(body.plan),
        outcome: "failed",
        httpStatus: result?.reason === "sold_out" ? 409 : 500,
        details: { reason: result?.reason || "rpc_failed" },
      });
      console.error("Admin plan update failed:", update.status, JSON.stringify(result).slice(0, 300));
      const reason = result?.reason === "sold_out"
        ? "All 50 Lifetime spots have been claimed."
        : "Could not update the plan. Please try again.";
      return json({ error: reason, ...result }, result?.reason === "sold_out" ? 409 : 500);
    }

    await writeAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      requestedPlan: String(body.plan),
      outcome: "succeeded",
      httpStatus: 200,
    });
    return json({ ok: true, plan: body.plan, ...result });
  };
}

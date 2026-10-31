import { assertEquals } from "jsr:@std/assert";
import { createAdminPlanHandler } from "./handler.ts";

const config = {
  supabaseUrl: "https://project.example",
  anonKey: "public-test-key",
  serviceRoleKey: "service-test-key",
  adminEmail: "owner@example.com",
};

Deno.test("normal authenticated user is rejected and the rejection is audited", async () => {
  const auditRows: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/v1/user")) {
      assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer normal-user-token");
      return new Response(JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        email: "normal@example.com",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      }), { status: 200 });
    }
    if (url.endsWith("/rest/v1/hookengine_admin_audit")) {
      auditRows.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    throw new Error("Unexpected fetch: " + url);
  };
  const handler = createAdminPlanHandler(config, fakeFetch);
  const response = await handler(new Request("https://edge.example/admin", {
    method: "POST",
    headers: { Authorization: "Bearer normal-user-token", "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "pro" }),
  }));
  assertEquals(response.status, 403);
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0].outcome, "rejected_not_admin");
  assertEquals(auditRows[0].http_status, 403);
  assertEquals(auditRows[0].actor_email, "normal@example.com");
  assertEquals(calls.some(url => url.endsWith("/rest/v1/rpc/hookengine_admin_set_plan")), false);
});

Deno.test("invalid session is rejected and audited", async () => {
  const auditRows: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response("{}", { status: 401 });
    if (url.endsWith("/rest/v1/hookengine_admin_audit")) {
      auditRows.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    throw new Error("Unexpected fetch: " + url);
  };
  const handler = createAdminPlanHandler(config, fakeFetch);
  const response = await handler(new Request("https://edge.example/admin", {
    method: "POST",
    headers: { Authorization: "Bearer expired-token", "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "pro" }),
  }));
  assertEquals(response.status, 401);
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0].outcome, "rejected_invalid_session");
});

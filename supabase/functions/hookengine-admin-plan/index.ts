import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAdminPlanHandler } from "./handler.ts";

Deno.serve(createAdminPlanHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL") || "",
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  adminEmail: "yayazan.mahmoud@gmail.com",
}));

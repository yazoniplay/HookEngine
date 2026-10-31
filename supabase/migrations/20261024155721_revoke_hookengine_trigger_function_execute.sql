-- Prevent browser-facing roles from directly invoking the SECURITY DEFINER signup trigger function.
revoke all on function public.hookengine_on_user_created() from public, anon, authenticated;

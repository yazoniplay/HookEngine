-- Remove non-RLS table capabilities from browser-facing roles.
-- Keep authenticated SELECT access; row-level security still limits rows to auth.uid().
revoke truncate, references, trigger
on table public.hookengine_profiles, public.hookengine_generations, public.hookengine_subscriptions
from anon, authenticated;

grant select
on table public.hookengine_profiles, public.hookengine_generations, public.hookengine_subscriptions
to authenticated;

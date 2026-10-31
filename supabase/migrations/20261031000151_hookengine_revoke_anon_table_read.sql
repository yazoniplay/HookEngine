-- Anonymous clients have no HookEngine read use case.
revoke select
on table public.hookengine_profiles, public.hookengine_generations, public.hookengine_subscriptions
from anon;

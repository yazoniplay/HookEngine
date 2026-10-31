-- Backfill accounts that existed before HookEngine account tables were installed.
insert into public.hookengine_profiles(user_id)
select id from auth.users
on conflict (user_id) do nothing;

insert into public.hookengine_subscriptions(user_id, plan, status)
select id, 'free', 'inactive' from auth.users
on conflict (user_id) do nothing;

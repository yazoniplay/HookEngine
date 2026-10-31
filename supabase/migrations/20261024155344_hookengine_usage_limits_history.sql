-- HookEngine account plans, per-user generation history, and atomic daily quota reservation.
create table if not exists public.hookengine_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro')),
  created_at timestamptz not null default now()
);
create table if not exists public.hookengine_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('article','youtube_video')),
  source_title text not null default '',
  source_url text not null default '',
  source_text text not null default '',
  x_thread text,
  linkedin_post text,
  tiktok_hooks text,
  status text not null default 'reserved' check (status in ('reserved','completed','failed')),
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists hookengine_generations_user_created_idx on public.hookengine_generations(user_id, created_at desc);
create index if not exists hookengine_generations_user_status_idx on public.hookengine_generations(user_id, status, created_at desc);
create table if not exists public.hookengine_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro')),
  status text not null default 'inactive' check (status in ('inactive','active','cancelled','past_due')),
  provider text not null default 'paypal' check (provider in ('paypal')),
  provider_subscription_id text unique,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.hookengine_profiles enable row level security;
alter table public.hookengine_generations enable row level security;
alter table public.hookengine_subscriptions enable row level security;
drop policy if exists "Users can read their HookEngine profile" on public.hookengine_profiles;
create policy "Users can read their HookEngine profile" on public.hookengine_profiles for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can read their own generation history" on public.hookengine_generations;
create policy "Users can read their own generation history" on public.hookengine_generations for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can read their own subscription" on public.hookengine_subscriptions;
create policy "Users can read their own subscription" on public.hookengine_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.hookengine_profiles from anon, authenticated;
revoke insert, update, delete on public.hookengine_generations from anon, authenticated;
revoke insert, update, delete on public.hookengine_subscriptions from anon, authenticated;
grant select on public.hookengine_profiles, public.hookengine_generations, public.hookengine_subscriptions to authenticated;
create or replace function public.hookengine_on_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.hookengine_profiles(user_id, plan) values (new.id, 'free') on conflict (user_id) do nothing;
  insert into public.hookengine_subscriptions(user_id, plan, status) values (new.id, 'free', 'inactive') on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists hookengine_auth_user_created on auth.users;
create trigger hookengine_auth_user_created after insert on auth.users for each row execute function public.hookengine_on_user_created();
create or replace function public.hookengine_reserve_generation(p_user_id uuid, p_source_type text, p_source_title text, p_source_url text, p_source_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan text := 'free'; v_limit integer := 5; v_used integer := 0; v_generation_id uuid;
begin
  if p_source_type not in ('article','youtube_video') then return jsonb_build_object('allowed', false, 'error', 'Invalid source type.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || (now() at time zone 'UTC')::date::text, 0));
  select case when s.status = 'active' and s.plan = 'pro' and (s.current_period_end is null or s.current_period_end > now()) then 'pro' else 'free' end into v_plan from public.hookengine_subscriptions s where s.user_id = p_user_id;
  if v_plan is null then v_plan := 'free'; end if;
  if v_plan = 'pro' then v_limit := 100; end if;
  select count(*)::integer into v_used from public.hookengine_generations g
  where g.user_id = p_user_id
    and g.created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    and g.created_at < (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC'
    and g.status in ('reserved','completed');
  if v_used >= v_limit then return jsonb_build_object('allowed', false, 'plan', v_plan, 'used', v_used, 'limit', v_limit, 'remaining', 0); end if;
  insert into public.hookengine_generations(user_id, source_type, source_title, source_url, source_text, status)
  values (p_user_id, p_source_type, left(coalesce(p_source_title,''),300), left(coalesce(p_source_url,''),2000), left(coalesce(p_source_text,''),60000), 'reserved') returning id into v_generation_id;
  return jsonb_build_object('allowed', true, 'plan', v_plan, 'used', v_used + 1, 'limit', v_limit, 'remaining', greatest(0, v_limit - v_used - 1), 'generation_id', v_generation_id);
end;
$$;
create or replace function public.hookengine_finish_generation(p_generation_id uuid, p_user_id uuid, p_status text, p_x_thread text default null, p_linkedin_post text default null, p_tiktok_hooks text default null, p_error_message text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('completed','failed') then return false; end if;
  update public.hookengine_generations set status = p_status,
    x_thread = case when p_status = 'completed' then p_x_thread else null end,
    linkedin_post = case when p_status = 'completed' then p_linkedin_post else null end,
    tiktok_hooks = case when p_status = 'completed' then p_tiktok_hooks else null end,
    error_message = case when p_status = 'failed' then left(coalesce(p_error_message,'Generation failed.'),500) else null end,
    completed_at = now()
  where id = p_generation_id and user_id = p_user_id and status = 'reserved';
  return found;
end;
$$;
revoke all on function public.hookengine_reserve_generation(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.hookengine_reserve_generation(uuid,text,text,text,text) to service_role;
grant execute on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text) to service_role;

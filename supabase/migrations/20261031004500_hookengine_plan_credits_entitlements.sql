-- HookEngine Phase 2: canonical plan entitlements, credits, reservations, refunds and cost telemetry.
-- All time windows are UTC. Browser roles never receive write access to billing or credit state.

alter table public.hookengine_profiles
  drop constraint if exists hookengine_profiles_plan_check;
alter table public.hookengine_profiles
  add constraint hookengine_profiles_plan_check
  check (plan in ('free','pro','trial','lifetime'));

alter table public.hookengine_subscriptions
  drop constraint if exists hookengine_subscriptions_plan_check;
alter table public.hookengine_subscriptions
  add constraint hookengine_subscriptions_plan_check
  check (plan in ('free','pro','trial','lifetime'));
alter table public.hookengine_subscriptions
  drop constraint if exists hookengine_subscriptions_status_check;
alter table public.hookengine_subscriptions
  add constraint hookengine_subscriptions_status_check
  check (status in ('inactive','active','cancelled','past_due','trialing'));

alter table public.hookengine_subscriptions
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists credits_balance integer not null default 0 check (credits_balance >= 0),
  add column if not exists credit_period_started_at timestamptz,
  add column if not exists credit_period_ends_at timestamptz,
  add column if not exists lifetime_claimed_at timestamptz;

alter table public.hookengine_generations
  add column if not exists action_type text not null default 'generation',
  add column if not exists parent_generation_id uuid references public.hookengine_generations(id) on delete set null,
  add column if not exists credits_reserved integer not null default 0,
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists latency_ms integer,
  add column if not exists model text,
  add column if not exists estimated_provider_cost_usd numeric(12,8);

alter table public.hookengine_generations
  drop constraint if exists hookengine_generations_action_type_check;
alter table public.hookengine_generations
  add constraint hookengine_generations_action_type_check
  check (action_type in ('generation','regeneration'));

create index if not exists hookengine_generations_pending_idx
  on public.hookengine_generations(user_id, reservation_expires_at)
  where status = 'reserved';
create index if not exists hookengine_generations_parent_action_idx
  on public.hookengine_generations(parent_generation_id, action_type, status);

create table if not exists public.hookengine_plans (
  plan_key text primary key check (plan_key in ('free','pro','trial','lifetime')),
  display_name text not null,
  billing_interval text not null check (billing_interval in ('none','weekly','monthly','trial','lifetime')),
  credits_per_period integer not null check (credits_per_period >= 0),
  daily_generation_limit integer not null check (daily_generation_limit >= 0),
  versions_per_generation integer not null check (versions_per_generation >= 1),
  regenerations_per_generation integer,
  platform_keys text[] not null,
  voice_enabled boolean not null default false,
  video_enabled boolean not null default false,
  history_days integer,
  trial_days integer,
  trial_credit_limit integer,
  lifetime_spot_limit integer,
  price_minor integer,
  price_currency text not null default 'EUR' check (price_currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  check (regenerations_per_generation is null or regenerations_per_generation >= 0),
  check (history_days is null or history_days >= 0),
  check (price_minor is null or price_minor >= 0)
);

insert into public.hookengine_plans
  (plan_key,display_name,billing_interval,credits_per_period,daily_generation_limit,versions_per_generation,regenerations_per_generation,platform_keys,voice_enabled,video_enabled,history_days,trial_days,trial_credit_limit,lifetime_spot_limit,price_minor,price_currency,is_active)
values
  ('free','Free','weekly',5,3,1,1,array['x_thread','linkedin_post','tiktok_hooks'],false,false,7,null,null,null,0,'EUR',true),
  ('pro','Pro','monthly',300,30,3,null,array['x_thread','linkedin_post','tiktok_hooks','instagram_caption','threads_posts','facebook_post'],true,true,null,null,null,null,499,'EUR',true),
  ('trial','Pro Trial','trial',40,30,3,null,array['x_thread','linkedin_post','tiktok_hooks','instagram_caption','threads_posts','facebook_post'],true,true,null,7,40,null,0,'EUR',true),
  ('lifetime','Lifetime','monthly',150,30,3,null,array['x_thread','linkedin_post','tiktok_hooks','instagram_caption','threads_posts','facebook_post'],true,true,null,null,null,50,null,'EUR',true)
on conflict (plan_key) do update set
  display_name=excluded.display_name,
  billing_interval=excluded.billing_interval,
  credits_per_period=excluded.credits_per_period,
  daily_generation_limit=excluded.daily_generation_limit,
  versions_per_generation=excluded.versions_per_generation,
  regenerations_per_generation=excluded.regenerations_per_generation,
  platform_keys=excluded.platform_keys,
  voice_enabled=excluded.voice_enabled,
  video_enabled=excluded.video_enabled,
  history_days=excluded.history_days,
  trial_days=excluded.trial_days,
  trial_credit_limit=excluded.trial_credit_limit,
  lifetime_spot_limit=excluded.lifetime_spot_limit,
  price_minor=excluded.price_minor,
  price_currency=excluded.price_currency,
  is_active=excluded.is_active,
  updated_at=now();

create table if not exists public.hookengine_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generation_id uuid references public.hookengine_generations(id) on delete set null,
  entry_type text not null check (entry_type in ('trial_grant','period_grant','period_expire','reservation','refund','admin_adjustment')),
  amount integer not null check (amount <> 0),
  balance_after integer not null check (balance_after >= 0),
  period_started_at timestamptz,
  period_ends_at timestamptz,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists hookengine_credit_ledger_user_created_idx
  on public.hookengine_credit_ledger(user_id, created_at desc);
create index if not exists hookengine_credit_ledger_generation_idx
  on public.hookengine_credit_ledger(generation_id)
  where generation_id is not null;

create table if not exists public.hookengine_model_rates (
  provider text not null,
  model text not null,
  input_usd_per_million numeric(12,6),
  output_usd_per_million numeric(12,6),
  price_source text,
  verified_at timestamptz,
  primary key (provider, model)
);
insert into public.hookengine_model_rates
  (provider,model,input_usd_per_million,output_usd_per_million,price_source,verified_at)
values
  ('Gemini','gemini-3.5-flash-lite',0.30,2.50,'https://ai.google.dev/gemini-api/docs/pricing',now())
on conflict (provider,model) do update set
  input_usd_per_million=excluded.input_usd_per_million,
  output_usd_per_million=excluded.output_usd_per_million,
  price_source=excluded.price_source,
  verified_at=excluded.verified_at;

alter table public.hookengine_plans enable row level security;
alter table public.hookengine_credit_ledger enable row level security;
alter table public.hookengine_model_rates enable row level security;
revoke all on public.hookengine_plans, public.hookengine_credit_ledger, public.hookengine_model_rates from anon, authenticated;
grant all on public.hookengine_plans, public.hookengine_credit_ledger, public.hookengine_model_rates to service_role;

-- New signups receive a seven-day / 40-credit Pro trial. Existing accounts are not silently upgraded.
create or replace function public.hookengine_on_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.hookengine_profiles(user_id, plan)
  values (new.id, 'trial')
  on conflict (user_id) do nothing;

  insert into public.hookengine_subscriptions(
    user_id, plan, status, trial_started_at, trial_ends_at,
    credits_balance, credit_period_started_at, credit_period_ends_at
  )
  values (
    new.id, 'trial', 'trialing', now(), now() + interval '7 days',
    40, now(), now() + interval '7 days'
  )
  on conflict (user_id) do nothing;

  insert into public.hookengine_credit_ledger(
    user_id, entry_type, amount, balance_after, period_started_at, period_ends_at,
    idempotency_key, metadata
  )
  values (
    new.id, 'trial_grant', 40, 40, now(), now() + interval '7 days',
    'trial-grant:' || new.id::text,
    jsonb_build_object('plan','trial','trial_days',7)
  )
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;
revoke all on function public.hookengine_on_user_created() from public, anon, authenticated;

-- Assign a monthly credit period when a plan has no current period or the UTC period rolled over.
create or replace function public.hookengine_refresh_credit_period(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.hookengine_subscriptions%rowtype;
  v_plan public.hookengine_plans%rowtype;
  v_now_utc timestamptz := timezone('UTC', now()) at time zone 'UTC';
  v_start timestamptz;
  v_end timestamptz;
  v_old_balance integer;
begin
  select * into v_sub
  from public.hookengine_subscriptions
  where user_id = p_user_id
  for update;

  if not found then
    insert into public.hookengine_subscriptions(user_id,plan,status)
    values (p_user_id,'free','inactive')
    on conflict (user_id) do nothing;
    select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
  end if;

  if (v_sub.plan = 'pro' and v_sub.status <> 'active')
     or (v_sub.plan = 'lifetime' and v_sub.status <> 'active') then
    update public.hookengine_subscriptions
    set plan='free',status='inactive',credits_balance=0,
        credit_period_started_at=null,credit_period_ends_at=null,updated_at=now()
    where user_id=p_user_id;
    update public.hookengine_profiles set plan='free' where user_id=p_user_id;
    select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
  end if;

  if v_sub.plan = 'trial' and (v_sub.trial_ends_at is null or v_sub.trial_ends_at <= now() or v_sub.credits_balance <= 0) then
    update public.hookengine_subscriptions
    set plan='free',status='inactive',trial_started_at=null,trial_ends_at=null,
        credits_balance=0,credit_period_started_at=null,credit_period_ends_at=null,updated_at=now()
    where user_id=p_user_id;
    update public.hookengine_profiles set plan='free' where user_id=p_user_id;
    select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
  end if;

  select * into v_plan from public.hookengine_plans where plan_key=v_sub.plan and is_active;
  if not found then
    select * into v_plan from public.hookengine_plans where plan_key='free';
  end if;

  if v_plan.billing_interval = 'weekly' then
    v_start := date_trunc('week', timezone('UTC', now())) at time zone 'UTC';
    v_end := v_start + interval '7 days';
  elsif v_plan.billing_interval = 'monthly' then
    v_start := date_trunc('month', timezone('UTC', now())) at time zone 'UTC';
    v_end := v_start + interval '1 month';
  elsif v_plan.billing_interval = 'trial' then
    return jsonb_build_object('plan',v_plan.plan_key,'credits_balance',v_sub.credits_balance,
      'period_started_at',v_sub.credit_period_started_at,'period_ends_at',v_sub.trial_ends_at);
  else
    return jsonb_build_object('plan',v_plan.plan_key,'credits_balance',v_sub.credits_balance,
      'period_started_at',v_sub.credit_period_started_at,'period_ends_at',v_sub.credit_period_ends_at);
  end if;

  if v_sub.credit_period_started_at is distinct from v_start then
    v_old_balance := v_sub.credits_balance;
    if v_old_balance > 0 then
      insert into public.hookengine_credit_ledger(
        user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
      )
      values (
        p_user_id,'period_expire',-v_old_balance,0,v_sub.credit_period_started_at,v_sub.credit_period_ends_at,
        'period-expire:'||p_user_id::text||':'||coalesce(v_sub.credit_period_started_at::text,'initial'),
        jsonb_build_object('plan',v_plan.plan_key)
      )
      on conflict (idempotency_key) do nothing;
    end if;

    update public.hookengine_subscriptions
    set credits_balance=v_plan.credits_per_period,
        credit_period_started_at=v_start,
        credit_period_ends_at=v_end,
        updated_at=now()
    where user_id=p_user_id;

    insert into public.hookengine_credit_ledger(
      user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
    )
    values (
      p_user_id,'period_grant',v_plan.credits_per_period,v_plan.credits_per_period,v_start,v_end,
      'period-grant:'||p_user_id::text||':'||v_plan.plan_key||':'||v_start::text,
      jsonb_build_object('plan',v_plan.plan_key,'billing_interval',v_plan.billing_interval)
    )
    on conflict (idempotency_key) do nothing;

    select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id;
  end if;

  return jsonb_build_object('plan',v_plan.plan_key,'credits_balance',v_sub.credits_balance,
    'period_started_at',v_sub.credit_period_started_at,'period_ends_at',v_sub.credit_period_ends_at);
end;
$$;

create or replace function public.hookengine_history_visible(p_created_at timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $
declare
  v_user_id uuid := auth.uid();
  v_history_days integer;
begin
  if v_user_id is null then return false; end if;
  select p.history_days into v_history_days
  from public.hookengine_subscriptions s
  join public.hookengine_plans p on p.plan_key=s.plan
  where s.user_id=v_user_id;
  if not found then v_history_days := 7; end if;
  return v_history_days is null or p_created_at >= now() - make_interval(days => v_history_days);
end;
$;
revoke all on function public.hookengine_history_visible(timestamptz) from public, anon;
grant execute on function public.hookengine_history_visible(timestamptz) to authenticated;

drop policy if exists "Users can read their own generation history" on public.hookengine_generations;
create policy "Users can read their own generation history"
on public.hookengine_generations for select to authenticated
using ((select auth.uid()) = user_id and public.hookengine_history_visible(created_at));

-- The only reservation entry point. User identity is supplied by the authenticated Edge Function.
create or replace function public.hookengine_reserve_generation(
  p_user_id uuid,
  p_source_type text,
  p_source_title text,
  p_source_url text,
  p_source_text text,
  p_action_type text default 'generation',
  p_parent_generation_id uuid default null,
  p_selected_platforms text[] default array['x_thread','linkedin_post','tiktok_hooks']::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day', timezone('UTC', now())) at time zone 'UTC';
  v_plan public.hookengine_plans%rowtype;
  v_sub public.hookengine_subscriptions%rowtype;
  v_refresh jsonb;
  v_cost integer;
  v_daily_used integer;
  v_pending integer;
  v_regenerations integer;
  v_generation_id uuid;
  v_selected text[] := coalesce(p_selected_platforms,array[]::text[]);
begin
  if p_user_id is null then
    return jsonb_build_object('allowed',false,'reason','missing_user','message','Sign in to continue.');
  end if;
  if p_source_type not in ('article','youtube_video') then
    return jsonb_build_object('allowed',false,'reason','invalid_source_type','message','Unsupported source type.');
  end if;
  if p_action_type not in ('generation','regeneration') then
    return jsonb_build_object('allowed',false,'reason','invalid_action','message','Unsupported generation action.');
  end if;
  if cardinality(v_selected)=0 then
    return jsonb_build_object('allowed',false,'reason','no_platforms','message','Choose at least one platform.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));

  v_refresh := public.hookengine_refresh_credit_period(p_user_id);
  select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
  select * into v_plan from public.hookengine_plans where plan_key=v_sub.plan and is_active;

  if v_plan.plan_key is null then
    select * into v_plan from public.hookengine_plans where plan_key='free';
  end if;

  if p_source_type='youtube_video' and not v_plan.video_enabled then
    return jsonb_build_object('allowed',false,'reason','video_not_included','plan',v_plan.plan_key,
      'message','Video analysis is included with Pro features.');
  end if;

  if not (v_selected <@ v_plan.platform_keys) then
    return jsonb_build_object('allowed',false,'reason','platform_not_included','plan',v_plan.plan_key,
      'allowed_platforms',v_plan.platform_keys,'message','One or more selected platforms require a higher plan.');
  end if;

  if v_plan.plan_key='trial' and (v_sub.trial_ends_at is null or v_sub.trial_ends_at <= v_now or v_sub.credits_balance <= 0) then
    return jsonb_build_object('allowed',false,'reason','trial_expired','plan','free','message','Your trial has ended. Your account is now on Free.');
  end if;

  select count(*)::integer into v_pending
  from public.hookengine_generations g
  where g.user_id=p_user_id and g.status='reserved'
    and g.created_at >= v_now - interval '5 minutes'
    and (g.reservation_expires_at is null or g.reservation_expires_at > v_now);
  if v_pending >= 2 then
    return jsonb_build_object('allowed',false,'reason','too_many_pending','plan',v_plan.plan_key,
      'pending',v_pending,'message','Please wait for your current generations to finish.');
  end if;

  select count(*)::integer into v_daily_used
  from public.hookengine_generations g
  where g.user_id=p_user_id and g.created_at >= v_day_start
    and g.created_at < v_day_start + interval '1 day'
    and g.status in ('reserved','completed');

  if v_daily_used >= v_plan.daily_generation_limit then
    return jsonb_build_object('allowed',false,'reason','daily_limit_reached','plan',v_plan.plan_key,
      'used',v_daily_used,'daily_limit',v_plan.daily_generation_limit,'credits_balance',v_sub.credits_balance,
      'message','You have reached your daily generation limit.');
  end if;

  if p_action_type='regeneration' then
    if p_parent_generation_id is null then
      return jsonb_build_object('allowed',false,'reason','missing_parent_generation','message','A source generation is required to regenerate.');
    end if;
    select count(*)::integer into v_regenerations
    from public.hookengine_generations g
    where g.parent_generation_id=p_parent_generation_id
      and g.action_type='regeneration' and g.status in ('reserved','completed');
    if v_plan.regenerations_per_generation is not null and v_regenerations >= v_plan.regenerations_per_generation then
      return jsonb_build_object('allowed',false,'reason','regeneration_limit_reached','plan',v_plan.plan_key,
        'message','You have reached the regeneration limit for this draft.');
    end if;
    v_cost := 1;
  else
    v_cost := case when p_source_type='youtube_video' then 5 else 1 end;
  end if;

  if v_sub.credits_balance < v_cost then
    return jsonb_build_object('allowed',false,'reason','insufficient_credits','plan',v_plan.plan_key,
      'credits_balance',v_sub.credits_balance,'credits_required',v_cost,
      'message','You do not have enough credits for this request.');
  end if;

  insert into public.hookengine_generations(
    user_id,source_type,source_title,source_url,source_text,status,action_type,parent_generation_id,
    credits_reserved,reservation_expires_at,selected_platforms
  )
  values (
    p_user_id,p_source_type,left(coalesce(p_source_title,''),300),left(coalesce(p_source_url,''),2000),
    left(coalesce(p_source_text,''),60000),'reserved',p_action_type,p_parent_generation_id,
    v_cost,v_now + interval '5 minutes',v_selected
  )
  returning id into v_generation_id;

  update public.hookengine_subscriptions
  set credits_balance=credits_balance-v_cost,updated_at=now()
  where user_id=p_user_id
  returning * into v_sub;

  insert into public.hookengine_credit_ledger(
    user_id,generation_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
  )
  values (
    p_user_id,v_generation_id,'reservation',-v_cost,v_sub.credits_balance,
    v_sub.credit_period_started_at,v_sub.credit_period_ends_at,
    'reservation:'||v_generation_id::text,
    jsonb_build_object('plan',v_plan.plan_key,'source_type',p_source_type,'action_type',p_action_type)
  );

  return jsonb_build_object(
    'allowed',true,'generation_id',v_generation_id,'plan',v_plan.plan_key,
    'credits_reserved',v_cost,'credits_balance',v_sub.credits_balance,
    'daily_used',v_daily_used+1,'daily_limit',v_plan.daily_generation_limit,
    'remaining_daily',greatest(0,v_plan.daily_generation_limit-v_daily_used-1),
    'versions_per_generation',v_plan.versions_per_generation,
    'regenerations_per_generation',v_plan.regenerations_per_generation,
    'allowed_platforms',v_plan.platform_keys,'voice_enabled',v_plan.voice_enabled,
    'video_enabled',v_plan.video_enabled,'history_days',v_plan.history_days
  );
end;
$$;

create or replace function public.hookengine_finish_generation(
  p_generation_id uuid,
  p_user_id uuid,
  p_status text,
  p_x_thread text default null,
  p_linkedin_post text default null,
  p_tiktok_hooks text default null,
  p_error_message text default null,
  p_outputs jsonb default '{}'::jsonb,
  p_selected_platforms text[] default array[]::text[],
  p_provider text default null,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_latency_ms integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation public.hookengine_generations%rowtype;
  v_balance integer;
  v_rate public.hookengine_model_rates%rowtype;
  v_cost numeric(12,8);
begin
  if p_status not in ('completed','failed') then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));

  select * into v_generation
  from public.hookengine_generations
  where id=p_generation_id and user_id=p_user_id and status='reserved'
  for update;
  if not found then return false; end if;

  if p_status='failed' then
    update public.hookengine_subscriptions
    set credits_balance=credits_balance+v_generation.credits_reserved,updated_at=now()
    where user_id=p_user_id
    returning credits_balance into v_balance;

    if v_generation.credits_reserved > 0 then
      insert into public.hookengine_credit_ledger(
        user_id,generation_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
      )
      values (
        p_user_id,p_generation_id,'refund',v_generation.credits_reserved,v_balance,
        (select credit_period_started_at from public.hookengine_subscriptions where user_id=p_user_id),
        (select credit_period_ends_at from public.hookengine_subscriptions where user_id=p_user_id),
        'refund:'||p_generation_id::text,jsonb_build_object('reason',left(coalesce(p_error_message,'Generation failed.'),300))
      )
      on conflict (idempotency_key) do nothing;
    end if;
  end if;

  if p_status='completed' and p_provider is not null and p_model is not null
      and p_input_tokens is not null and p_output_tokens is not null then
    select * into v_rate from public.hookengine_model_rates
    where provider=p_provider and model=p_model;
    if found and v_rate.input_usd_per_million is not null and v_rate.output_usd_per_million is not null then
      v_cost := ((greatest(p_input_tokens,0)::numeric * v_rate.input_usd_per_million)
        + (greatest(p_output_tokens,0)::numeric * v_rate.output_usd_per_million)) / 1000000;
    end if;
  end if;

  update public.hookengine_generations
  set status=p_status,
      x_thread=case when p_status='completed' then p_x_thread else null end,
      linkedin_post=case when p_status='completed' then p_linkedin_post else null end,
      tiktok_hooks=case when p_status='completed' then p_tiktok_hooks else null end,
      outputs=case when p_status='completed' then coalesce(p_outputs,'{}'::jsonb) else '{}'::jsonb end,
      selected_platforms=case when p_status='completed' then coalesce(p_selected_platforms,array[]::text[]) else array[]::text[] end,
      provider=case when p_status='completed' then left(p_provider,40) else null end,
      model=case when p_status='completed' then left(p_model,100) else null end,
      input_tokens=case when p_status='completed' then greatest(p_input_tokens,0) else null end,
      output_tokens=case when p_status='completed' then greatest(p_output_tokens,0) else null end,
      latency_ms=case when p_status='completed' then greatest(p_latency_ms,0) else null end,
      estimated_provider_cost_usd=case when p_status='completed' then v_cost else null end,
      error_message=case when p_status='failed' then left(coalesce(p_error_message,'Generation failed.'),500) else null end,
      refunded_at=case when p_status='failed' then now() else null end,
      reservation_expires_at=null,
      completed_at=now()
  where id=p_generation_id and user_id=p_user_id and status='reserved';

  return found;
end;
$$;

create or replace function public.hookengine_get_usage()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_refresh jsonb;
  v_sub public.hookengine_subscriptions%rowtype;
  v_plan public.hookengine_plans%rowtype;
  v_day_start timestamptz := date_trunc('day', timezone('UTC', now())) at time zone 'UTC';
  v_used integer;
  v_history_cutoff timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='28000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||v_user_id::text,0));
  v_refresh := public.hookengine_refresh_credit_period(v_user_id);
  select * into v_sub from public.hookengine_subscriptions where user_id=v_user_id;
  select * into v_plan from public.hookengine_plans where plan_key=v_sub.plan;

  select count(*)::integer into v_used
  from public.hookengine_generations g
  where g.user_id=v_user_id and g.created_at>=v_day_start
    and g.created_at<v_day_start+interval '1 day'
    and g.status in ('reserved','completed');

  v_history_cutoff := case when v_plan.history_days is null then null else now()-(v_plan.history_days||' days')::interval end;

  return jsonb_build_object(
    'plan',v_plan.plan_key,'display_name',v_plan.display_name,
    'credits_balance',v_sub.credits_balance,'credits_per_period',v_plan.credits_per_period,
    'period_started_at',v_sub.credit_period_started_at,'period_ends_at',coalesce(v_sub.trial_ends_at,v_sub.credit_period_ends_at),
    'daily_used',v_used,'daily_limit',v_plan.daily_generation_limit,
    'remaining_daily',greatest(0,v_plan.daily_generation_limit-v_used),
    'versions_per_generation',v_plan.versions_per_generation,
    'regenerations_per_generation',v_plan.regenerations_per_generation,
    'platforms',v_plan.platform_keys,'voice_enabled',v_plan.voice_enabled,
    'video_enabled',v_plan.video_enabled,'history_days',v_plan.history_days,
    'history_cutoff',v_history_cutoff,'trial_ends_at',v_sub.trial_ends_at,
    'lifetime_claimed_at',v_sub.lifetime_claimed_at
  );
end;
$$;

create or replace function public.hookengine_cleanup_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_row record;
  v_count integer := 0;
  v_balance integer;
begin
  -- Always acquire the per-user advisory lock before locking generation rows.
  for v_user in
    select distinct user_id
    from public.hookengine_generations
    where status='reserved' and reservation_expires_at is not null and reservation_expires_at<=now()
    order by user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||v_user.user_id::text,0));
    for v_row in
      select id,user_id,credits_reserved
      from public.hookengine_generations
      where user_id=v_user.user_id and status='reserved'
        and reservation_expires_at is not null and reservation_expires_at<=now()
      order by reservation_expires_at
      for update skip locked
      limit 100
    loop
      update public.hookengine_subscriptions
      set credits_balance=credits_balance+v_row.credits_reserved,updated_at=now()
      where user_id=v_row.user_id
      returning credits_balance into v_balance;

      insert into public.hookengine_credit_ledger(
        user_id,generation_id,entry_type,amount,balance_after,idempotency_key,metadata
      )
      values (
        v_row.user_id,v_row.id,'refund',v_row.credits_reserved,v_balance,
        'refund:'||v_row.id::text,jsonb_build_object('reason','reservation_timeout')
      )
      on conflict (idempotency_key) do nothing;

      update public.hookengine_generations
      set status='failed',error_message='Generation timed out.',refunded_at=now(),
          reservation_expires_at=null,completed_at=now()
      where id=v_row.id and status='reserved';
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

create or replace function public.hookengine_expire_trials()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_count integer := 0;
begin
  for v_user in
    select user_id
    from public.hookengine_subscriptions
    where plan='trial' and (trial_ends_at<=now() or credits_balance<=0)
    order by user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||v_user.user_id::text,0));
    update public.hookengine_subscriptions
    set plan='free',status='inactive',trial_started_at=null,trial_ends_at=null,
        credits_balance=0,credit_period_started_at=null,credit_period_ends_at=null,updated_at=now()
    where user_id=v_user.user_id and plan='trial'
      and (trial_ends_at<=now() or credits_balance<=0);
    if found then
      update public.hookengine_profiles set plan='free' where user_id=v_user.user_id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.hookengine_assign_lifetime(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_claimed integer;
  v_start timestamptz := date_trunc('month', timezone('UTC',now())) at time zone 'UTC';
  v_end timestamptz := (date_trunc('month', timezone('UTC',now())) + interval '1 month') at time zone 'UTC';
begin
  perform pg_advisory_xact_lock(hashtextextended('hookengine-lifetime-claims',0));
  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));
  if exists (select 1 from public.hookengine_subscriptions where user_id=p_user_id and plan='lifetime') then
    return jsonb_build_object('assigned',false,'reason','already_lifetime');
  end if;
  select lifetime_spot_limit into v_limit from public.hookengine_plans where plan_key='lifetime';
  select count(*)::integer into v_claimed from public.hookengine_subscriptions where plan='lifetime';
  if v_claimed >= coalesce(v_limit,50) then
    return jsonb_build_object('assigned',false,'reason','sold_out','claimed',v_claimed,'limit',v_limit);
  end if;

  update public.hookengine_subscriptions
  set plan='lifetime',status='active',provider='paypal',provider_subscription_id=null,
      current_period_end=null,lifetime_claimed_at=coalesce(lifetime_claimed_at,now()),
      credits_balance=150,credit_period_started_at=v_start,credit_period_ends_at=v_end,updated_at=now()
  where user_id=p_user_id;

  if not found then
    return jsonb_build_object('assigned',false,'reason','account_not_found');
  end if;

  update public.hookengine_profiles set plan='lifetime' where user_id=p_user_id;

  insert into public.hookengine_credit_ledger(
    user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
  )
  values (
    p_user_id,'admin_adjustment',150,150,v_start,v_end,
    'lifetime-initial-grant:'||p_user_id::text,jsonb_build_object('plan','lifetime')
  )
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('assigned',true,'plan','lifetime','credits_balance',150,'claimed',v_claimed+1,'limit',v_limit);
end;
$$;

-- Retire old quota RPC overloads so callers cannot accidentally bypass the new credit reservation path.
drop function if exists public.hookengine_reserve_generation(uuid,text,text,text,text);
drop function if exists public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text);
drop function if exists public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text);

revoke all on function public.hookengine_refresh_credit_period(uuid) from public, anon, authenticated;
revoke all on function public.hookengine_reserve_generation(uuid,text,text,text,text,text,uuid,text[]) from public, anon, authenticated;
revoke all on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text,text,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.hookengine_get_usage() from public, anon;
revoke all on function public.hookengine_cleanup_reservations() from public, anon, authenticated;
revoke all on function public.hookengine_expire_trials() from public, anon, authenticated;
revoke all on function public.hookengine_assign_lifetime(uuid) from public, anon, authenticated;
grant execute on function public.hookengine_reserve_generation(uuid,text,text,text,text,text,uuid,text[]) to service_role;
grant execute on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text,text,integer,integer,integer) to service_role;
grant execute on function public.hookengine_get_usage() to authenticated;
grant execute on function public.hookengine_cleanup_reservations() to service_role;
grant execute on function public.hookengine_expire_trials() to service_role;
grant execute on function public.hookengine_assign_lifetime(uuid) to service_role;

-- Enable Supabase Cron and schedule bounded maintenance jobs.
create extension if not exists pg_cron;
select cron.schedule('hookengine-reservation-cleanup','* * * * *','select public.hookengine_cleanup_reservations();');
select cron.schedule('hookengine-trial-expiry','5 * * * *','select public.hookengine_expire_trials();');

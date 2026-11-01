-- HookEngine Phase 2 specification alignment.
-- Adds the missing usage contract, source minimization, explicit credit costs,
-- UTC windows, and least-privilege table/function access without editing old migrations.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

update public.hookengine_plans set price_minor=null where plan_key in ('pro','lifetime');

-- Keep the existing column names used by billing code, but expose the requested
-- normalized period value for clients and diagnostics.
alter table public.hookengine_plans
  add column if not exists period text generated always as (
    case billing_interval
      when 'weekly' then 'week'
      when 'monthly' then 'month'
      when 'trial' then 'trial'
      else billing_interval
    end
  ) stored;

alter table public.hookengine_generations
  add column if not exists tokens_in bigint,
  add column if not exists tokens_out bigint,
  add column if not exists source_seconds numeric(12,3),
  add column if not exists source_hash text,
  add column if not exists source_length integer,
  add column if not exists cost_units integer not null default 0;

-- Backfill a one-way SHA-256 fingerprint before clearing all legacy source text.
update public.hookengine_generations
set source_hash = encode(extensions.digest(convert_to(source_text,'UTF8'),'sha256'),'hex'),
    source_length = char_length(source_text)
where source_hash is null and source_text is not null;

update public.hookengine_generations
set tokens_in = input_tokens,
    tokens_out = output_tokens,
    cost_units = case when status='completed' then credits_reserved else 0 end
where tokens_in is null or tokens_out is null or cost_units=0;

alter table public.hookengine_generations
  alter column source_text drop not null,
  alter column source_text drop default,
  alter column source_text set default null;

update public.hookengine_generations set source_text=null where source_text is not null;

-- Accept transcript-first YouTube as text (one credit); video analysis remains
-- separately gated and costs five credits.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid='public.hookengine_generations'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) ilike '%source_type%'
  loop
    execute format('alter table public.hookengine_generations drop constraint %I',c.conname);
  end loop;
end $$;

alter table public.hookengine_generations
  add constraint hookengine_generations_source_type_check
  check (source_type in ('article','youtube_transcript','youtube_video'));

create index if not exists hookengine_generations_source_hash_idx
  on public.hookengine_generations(user_id,source_hash)
  where source_hash is not null;

-- Replace the previous reservation signature instead of leaving an ambiguous
-- PostgREST overload. The cost argument is accepted but checked against the
-- server-owned plan/source rules; callers cannot undercharge.
drop function if exists public.hookengine_reserve_generation(uuid,text,text,text,text,text,uuid,text[]);

create function public.hookengine_reserve_generation(
  p_user_id uuid,
  p_source_type text,
  p_source_title text,
  p_source_url text,
  p_source_text text,
  p_action_type text default 'generation',
  p_parent_generation_id uuid default null,
  p_selected_platforms text[] default array['x_thread','linkedin_post','tiktok_hooks']::text[],
  p_cost integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day',timezone('UTC',now())) at time zone 'UTC';
  v_plan public.hookengine_plans%rowtype;
  v_sub public.hookengine_subscriptions%rowtype;
  v_refresh jsonb;
  v_expected_cost integer;
  v_cost integer;
  v_daily_used integer;
  v_pending integer;
  v_regenerations integer;
  v_parent public.hookengine_generations%rowtype;
  v_generation_id uuid;
  v_selected text[] := coalesce(p_selected_platforms,array[]::text[]);
  v_source_text text := left(coalesce(p_source_text,''),60000);
  v_source_hash text;
  v_source_length integer;
  v_limit_reason text;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed',false,'reason','missing_user','message','Sign in to continue.');
  end if;
  if p_source_type is null or p_source_type not in ('article','youtube_transcript','youtube_video') then
    return jsonb_build_object('allowed',false,'reason','invalid_source_type','message','Unsupported source type.');
  end if;
  if p_action_type is null or p_action_type not in ('generation','regeneration') then
    return jsonb_build_object('allowed',false,'reason','invalid_action','message','Unsupported generation action.');
  end if;
  if cardinality(v_selected)=0 then
    return jsonb_build_object('allowed',false,'reason','no_platforms','message','Choose at least one platform.');
  end if;

  v_expected_cost := case when p_source_type='youtube_video' then 5 else 1 end;
  v_cost := coalesce(p_cost,v_expected_cost);
  if v_cost <> v_expected_cost then
    return jsonb_build_object('allowed',false,'reason','invalid_cost','expected_cost',v_expected_cost,
      'message','The requested credit cost does not match the source type.');
  end if;
  v_source_hash := encode(extensions.digest(convert_to(v_source_text,'UTF8'),'sha256'),'hex');
  v_source_length := char_length(v_source_text);

  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));

  v_refresh := public.hookengine_refresh_credit_period(p_user_id);
  select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
  select * into v_plan from public.hookengine_plans where plan_key=v_sub.plan and is_active;

  if v_plan.plan_key is null then
    select * into v_plan from public.hookengine_plans where plan_key='free';
  end if;

  if v_plan.plan_key='trial'
     and (v_sub.trial_ends_at is null or v_sub.trial_ends_at<=v_now or v_sub.credits_balance<=0) then
    return jsonb_build_object('allowed',false,'reason','trial_expired','plan','free',
      'reset_at',v_sub.trial_ends_at,'message','Your trial has ended. Your account is now on Free.');
  end if;

  if p_source_type='youtube_video' and not v_plan.video_enabled then
    return jsonb_build_object('allowed',false,'reason','feature_locked','plan',v_plan.plan_key,
      'feature','video_analysis','message','Full video analysis is included with Pro features. A transcript can be used on Free.');
  end if;

  if not (v_selected <@ v_plan.platform_keys) then
    return jsonb_build_object('allowed',false,'reason','feature_locked','plan',v_plan.plan_key,
      'feature','platforms','allowed_platforms',v_plan.platform_keys,
      'message','One or more selected platforms require a higher plan.');
  end if;

  -- Two simultaneous reservations younger than two minutes are the maximum.
  select count(*)::integer into v_pending
  from public.hookengine_generations g
  where g.user_id=p_user_id and g.status='reserved'
    and g.created_at>=v_now-interval '2 minutes'
    and (g.reservation_expires_at is null or g.reservation_expires_at>v_now);
  if v_pending>=2 then
    return jsonb_build_object('allowed',false,'reason','too_many_pending','plan',v_plan.plan_key,
      'pending',v_pending,'message','Please wait for your current generations to finish.');
  end if;

  select count(*)::integer into v_daily_used
  from public.hookengine_generations g
  where g.user_id=p_user_id and g.created_at>=v_day_start
    and g.created_at<v_day_start+interval '1 day'
    and g.status in ('reserved','completed');

  if v_daily_used>=v_plan.daily_generation_limit then
    return jsonb_build_object('allowed',false,'reason','daily_cap','legacy_reason','daily_limit_reached',
      'plan',v_plan.plan_key,'used',v_daily_used,'daily_limit',v_plan.daily_generation_limit,
      'reset_at',v_day_start+interval '1 day','credits_balance',v_sub.credits_balance,
      'message','You have reached your daily generation limit.');
  end if;

  if p_action_type='regeneration' then
    if p_parent_generation_id is null then
      return jsonb_build_object('allowed',false,'reason','missing_parent_generation',
        'message','A source generation is required to regenerate.');
    end if;
    select * into v_parent
    from public.hookengine_generations
    where id=p_parent_generation_id and user_id=p_user_id and status='completed';
    if not found then
      return jsonb_build_object('allowed',false,'reason','parent_generation_not_found',
        'message','The source draft could not be found.');
    end if;
    if v_parent.action_type<>'generation' then
      return jsonb_build_object('allowed',false,'reason','invalid_regeneration_parent',
        'message','Regenerate from the original source draft, not from another regeneration.');
    end if;
    if v_parent.source_type<>p_source_type
       or v_parent.source_url<>left(coalesce(p_source_url,''),2000)
       or v_parent.source_hash is distinct from v_source_hash then
      return jsonb_build_object('allowed',false,'reason','regeneration_source_mismatch',
        'message','Regeneration must use the same source as the original draft.');
    end if;
    select count(*)::integer into v_regenerations
    from public.hookengine_generations g
    where g.parent_generation_id=p_parent_generation_id
      and g.action_type='regeneration' and g.status in ('reserved','completed');
    if v_plan.regenerations_per_generation is not null
       and v_regenerations>=v_plan.regenerations_per_generation then
      return jsonb_build_object('allowed',false,'reason','regeneration_limit_reached','plan',v_plan.plan_key,
        'message','You have reached the regeneration limit for this draft.');
    end if;
  end if;

  if v_sub.credits_balance<v_cost then
    v_limit_reason := case v_plan.billing_interval
      when 'weekly' then 'weekly_limit'
      when 'monthly' then 'monthly_limit'
      else 'insufficient_credits'
    end;
    return jsonb_build_object('allowed',false,'reason',v_limit_reason,'plan',v_plan.plan_key,
      'credits_balance',v_sub.credits_balance,'credits_required',v_cost,
      'reset_at',coalesce(v_sub.credit_period_ends_at,v_sub.trial_ends_at),
      'message','You have used the credits available in this plan period.');
  end if;

  insert into public.hookengine_generations(
    user_id,source_type,source_title,source_url,source_text,source_hash,source_length,
    status,action_type,parent_generation_id,credits_reserved,cost_units,
    reservation_expires_at,selected_platforms,credit_period_started_at,credit_period_ends_at
  )
  values (
    p_user_id,p_source_type,left(coalesce(p_source_title,''),300),left(coalesce(p_source_url,''),2000),
    null,v_source_hash,v_source_length,'reserved',p_action_type,p_parent_generation_id,
    v_cost,0,v_now+interval '5 minutes',v_selected,v_sub.credit_period_started_at,v_sub.credit_period_ends_at
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
    jsonb_build_object('plan',v_plan.plan_key,'source_type',p_source_type,
      'action_type',p_action_type,'cost_units',v_cost)
  );

  return jsonb_build_object(
    'allowed',true,'generation_id',v_generation_id,'plan',v_plan.plan_key,
    'credits_reserved',v_cost,'credits_balance',v_sub.credits_balance,
    'daily_used',v_daily_used+1,'daily_limit',v_plan.daily_generation_limit,
    'remaining_daily',greatest(0,v_plan.daily_generation_limit-v_daily_used-1),
    'versions_per_generation',v_plan.versions_per_generation,
    'regenerations_per_generation',v_plan.regenerations_per_generation,
    'allowed_platforms',v_plan.platform_keys,'voice_enabled',v_plan.voice_enabled,
    'video_enabled',v_plan.video_enabled,'history_days',v_plan.history_days,
    'window_start',v_sub.credit_period_started_at,'reset_at',coalesce(v_sub.credit_period_ends_at,v_sub.trial_ends_at),
    'source_hash',v_source_hash,'source_length',v_source_length
  );
end;
$function$;

-- Extend finalization with source duration and mirror telemetry into the requested
-- column names while preserving the legacy fields used by the current portal.
drop function if exists public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text,text,integer,integer,integer);

create function public.hookengine_finish_generation(
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
  p_latency_ms integer default null,
  p_source_seconds numeric default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation public.hookengine_generations%rowtype;
  v_sub public.hookengine_subscriptions%rowtype;
  v_balance integer;
  v_refunded boolean := false;
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
    select * into v_sub from public.hookengine_subscriptions where user_id=p_user_id for update;
    if found
      and v_sub.credit_period_started_at is not distinct from v_generation.credit_period_started_at
      and v_sub.credit_period_ends_at is not distinct from v_generation.credit_period_ends_at
      and v_generation.credits_reserved>0 then
      update public.hookengine_subscriptions
      set credits_balance=credits_balance+v_generation.credits_reserved,updated_at=now()
      where user_id=p_user_id returning credits_balance into v_balance;
      v_refunded := true;
      insert into public.hookengine_credit_ledger(
        user_id,generation_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
      ) values (
        p_user_id,p_generation_id,'refund',v_generation.credits_reserved,v_balance,
        v_sub.credit_period_started_at,v_sub.credit_period_ends_at,
        'refund:'||p_generation_id::text,
        jsonb_build_object('reason',left(coalesce(p_error_message,'Generation failed.'),300))
      ) on conflict (idempotency_key) do nothing;
    end if;
  end if;

  if p_status='completed' and p_provider is not null and p_model is not null
     and p_input_tokens is not null and p_output_tokens is not null then
    select * into v_rate from public.hookengine_model_rates where provider=p_provider and model=p_model;
    if found and v_rate.input_usd_per_million is not null and v_rate.output_usd_per_million is not null then
      v_cost := ((greatest(p_input_tokens,0)::numeric*v_rate.input_usd_per_million)
        +(greatest(p_output_tokens,0)::numeric*v_rate.output_usd_per_million))/1000000;
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
      tokens_in=case when p_status='completed' then greatest(p_input_tokens,0)::bigint else null end,
      tokens_out=case when p_status='completed' then greatest(p_output_tokens,0)::bigint else null end,
      latency_ms=case when p_status='completed' then greatest(p_latency_ms,0) else null end,
      source_seconds=case when p_status='completed' and p_source_seconds is not null then greatest(p_source_seconds,0) else null end,
      cost_units=case when p_status='completed' then credits_reserved else 0 end,
      estimated_provider_cost_usd=case when p_status='completed' then v_cost else null end,
      error_message=case when p_status='failed' then left(coalesce(p_error_message,'Generation failed.'),500) else null end,
      refunded_at=case when p_status='failed' and v_refunded then now() else null end,
      reservation_expires_at=null,
      completed_at=now()
  where id=p_generation_id and user_id=p_user_id and status='reserved';

  return found;
end;
$function$;

-- Security-invoker usage RPC. All underlying reads are protected by the same
-- owner-only RLS policies as direct account/history reads.
create or replace function public.hookengine_my_usage()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_sub public.hookengine_subscriptions%rowtype;
  v_plan public.hookengine_plans%rowtype;
  v_plan_key text;
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day',timezone('UTC',now())) at time zone 'UTC';
  v_window_start timestamptz;
  v_reset_at timestamptz;
  v_balance integer := 0;
  v_daily_used integer := 0;
  v_completed integer := 0;
  v_tokens_in bigint := 0;
  v_tokens_out bigint := 0;
  v_credits_consumed bigint := 0;
  v_provider_cost numeric(14,8) := 0;
  v_unpriced integer := 0;
  v_avg_latency integer := 0;
  v_history_cutoff timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode='28000';
  end if;

  select * into v_sub from public.hookengine_subscriptions where user_id=v_user_id;
  v_plan_key := coalesce(v_sub.plan,'free');

  if v_plan_key='trial' and
     (v_sub.trial_ends_at is null or v_sub.trial_ends_at<=v_now or coalesce(v_sub.credits_balance,0)<=0) then
    v_plan_key := 'free';
  elsif v_plan_key='pro' and
     (v_sub.status<>'active' or (v_sub.current_period_end is not null and v_sub.current_period_end<=v_now)) then
    v_plan_key := 'free';
  elsif v_plan_key='lifetime' and v_sub.status<>'active' then
    v_plan_key := 'free';
  end if;

  select * into v_plan from public.hookengine_plans where plan_key=v_plan_key and is_active;
  if not found then
    raise exception 'HookEngine plan configuration is missing';
  end if;

  if v_plan.billing_interval='weekly' then
    v_window_start := date_trunc('week',timezone('UTC',v_now)) at time zone 'UTC';
    v_reset_at := v_window_start+interval '7 days';
  elsif v_plan.billing_interval='monthly' then
    v_window_start := date_trunc('month',timezone('UTC',v_now)) at time zone 'UTC';
    v_reset_at := v_window_start+interval '1 month';
  else
    v_window_start := v_sub.trial_started_at;
    v_reset_at := v_sub.trial_ends_at;
  end if;

  if v_sub.user_id is null then
    v_balance := v_plan.credits_per_period;
  elsif v_plan.billing_interval in ('weekly','monthly')
    and v_sub.credit_period_started_at is distinct from v_window_start then
    v_balance := v_plan.credits_per_period;
  else
    v_balance := coalesce(v_sub.credits_balance,0);
  end if;

  select count(*)::integer into v_daily_used
  from public.hookengine_generations g
  where g.user_id=v_user_id and g.created_at>=v_day_start
    and g.created_at<v_day_start+interval '1 day'
    and g.status in ('reserved','completed');

  select
    count(*) filter (where g.status='completed')::integer,
    coalesce(sum(coalesce(g.tokens_in,g.input_tokens)) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(coalesce(g.tokens_out,g.output_tokens)) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(g.credits_reserved) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(g.estimated_provider_cost_usd) filter (where g.status='completed'),0)::numeric(14,8),
    count(*) filter (where g.status='completed' and (g.input_tokens is not null or g.output_tokens is not null)
      and g.estimated_provider_cost_usd is null)::integer,
    coalesce(round(avg(g.latency_ms) filter (where g.status='completed')),0)::integer
  into v_completed,v_tokens_in,v_tokens_out,v_credits_consumed,v_provider_cost,v_unpriced,v_avg_latency
  from public.hookengine_generations g where g.user_id=v_user_id;

  v_history_cutoff := case when v_plan.history_days is null then null
    else v_now-(v_plan.history_days||' days')::interval end;

  return jsonb_build_object(
    'plan',v_plan.plan_key,
    'period',v_plan.period,
    'price_minor',v_plan.price_minor,
    'price_currency',v_plan.price_currency,
    'window_start',v_window_start,
    'reset_at',v_reset_at,
    'credits_used',greatest(0,v_plan.credits_per_period-v_balance),
    'credits_total',v_plan.credits_per_period,
    'credits_balance',v_balance,
    'credits_per_period',v_plan.credits_per_period,
    'daily_used',v_daily_used,
    'daily_limit',v_plan.daily_generation_limit,
    'remaining_daily',greatest(0,v_plan.daily_generation_limit-v_daily_used),
    'trial_ends_at',v_sub.trial_ends_at,
    'platforms',v_plan.platform_keys,
    'voice_profile',v_plan.voice_enabled,
    'voice_enabled',v_plan.voice_enabled,
    'video_analysis',v_plan.video_enabled,
    'video_enabled',v_plan.video_enabled,
    'history_days',v_plan.history_days,
    'history_cutoff',v_history_cutoff,
    'versions_per_generation',v_plan.versions_per_generation,
    'regenerations_per_generation',v_plan.regenerations_per_generation,
    'total_generations',v_completed,
    'total_input_tokens',v_tokens_in,
    'total_output_tokens',v_tokens_out,
    'total_tokens',v_tokens_in+v_tokens_out,
    'credits_consumed',v_credits_consumed,
    'estimated_provider_cost_usd',v_provider_cost,
    'average_latency_ms',v_avg_latency,
    'unpriced_generations',v_unpriced,
    'lifetime_limit',(select lifetime_spot_limit from public.hookengine_plans where plan_key='lifetime'),
    'lifetime_claimed',(case when v_sub.lifetime_claimed_at is not null then 1 else 0 end)
  );
end;
$function$;

-- history_visible is called from an owner-scoped RLS policy. It does not need
-- SECURITY DEFINER: its reads now obey the caller's own-row policies.
create or replace function public.hookengine_history_visible(p_created_at timestamptz)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_history_days integer;
begin
  if v_user_id is null then return false; end if;
  select p.history_days into v_history_days
  from public.hookengine_subscriptions s
  join public.hookengine_plans p on p.plan_key=case
    when s.plan='trial' and (s.trial_ends_at is null or s.trial_ends_at<=now() or s.credits_balance<=0) then 'free'
    when s.plan='pro' and (s.status<>'active' or (s.current_period_end is not null and s.current_period_end<=now())) then 'free'
    when s.plan='lifetime' and s.status<>'active' then 'free'
    else s.plan end
  where s.user_id=v_user_id;
  if not found then v_history_days:=7; end if;
  return v_history_days is null or p_created_at>=now()-make_interval(days=>v_history_days);
end;
$function$;

-- Plan metadata is safe to expose; subscription and generation rows remain
-- restricted to each authenticated user's own records.
drop policy if exists "Authenticated users can read active HookEngine plans" on public.hookengine_plans;
create policy "Authenticated users can read active HookEngine plans"
  on public.hookengine_plans for select to authenticated using (is_active);

revoke all on public.hookengine_credit_ledger,
  public.hookengine_generations,
  public.hookengine_model_rates,
  public.hookengine_paypal_webhook_events,
  public.hookengine_plans,
  public.hookengine_profiles,
  public.hookengine_subscriptions
from public,anon,authenticated;

grant select on public.hookengine_generations,
  public.hookengine_profiles,
  public.hookengine_subscriptions,
  public.hookengine_plans
to authenticated;

-- Revoke the default PUBLIC function grant on every HookEngine routine. Only
-- the authenticated usage/history functions are exposed to browser sessions.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'hookengine_%'
  loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end $$;

grant execute on function public.hookengine_my_usage() to authenticated;
grant execute on function public.hookengine_history_visible(timestamptz) to authenticated;

-- Preserve compatibility for the currently published Chrome Web Store build.
-- The legacy RPC becomes a SECURITY INVOKER wrapper around the canonical function.
create or replace function public.hookengine_get_usage()
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.hookengine_my_usage();
$function$;

revoke all on function public.hookengine_get_usage() from public,anon,authenticated;
grant execute on function public.hookengine_get_usage() to authenticated,service_role;

-- Source text is never retained. The scheduled job is a safety net for legacy
-- or manually imported rows; generated outputs and plan-based history remain.
create or replace function public.hookengine_source_retention_cleanup()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  update public.hookengine_generations
  set source_text=null
  where source_text is not null
    and created_at<now()-interval '90 days';
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

revoke all on function public.hookengine_source_retention_cleanup() from public,anon,authenticated;
grant execute on function public.hookengine_source_retention_cleanup() to service_role;

do $$
begin
  if not exists(select 1 from cron.job where jobname='hookengine-source-retention') then
    perform cron.schedule('hookengine-source-retention','25 3 * * *',
      'select public.hookengine_source_retention_cleanup();');
  end if;
end $$;

notify pgrst,'reload schema';

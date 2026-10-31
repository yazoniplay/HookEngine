-- Phase 2.1: make usage reporting complete and add safe admin plan assignment.
-- The public account portal can read only its own aggregate usage through hookengine_get_usage().
-- Administrative plan changes are restricted to service_role and are never exposed to browser clients.

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
  v_completed integer := 0;
  v_input_tokens bigint := 0;
  v_output_tokens bigint := 0;
  v_credits_consumed bigint := 0;
  v_provider_cost numeric(14,8) := 0;
  v_avg_latency integer := 0;
  v_lifetime_claimed integer := 0;
  v_lifetime_limit integer := 50;
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

  select
    count(*) filter (where g.status='completed')::integer,
    coalesce(sum(g.input_tokens) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(g.output_tokens) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(g.credits_reserved) filter (where g.status='completed'),0)::bigint,
    coalesce(sum(g.estimated_provider_cost_usd) filter (where g.status='completed'),0)::numeric(14,8),
    coalesce(round(avg(g.latency_ms) filter (where g.status='completed')),0)::integer
  into v_completed,v_input_tokens,v_output_tokens,v_credits_consumed,v_provider_cost,v_avg_latency
  from public.hookengine_generations g
  where g.user_id=v_user_id;

  select count(*)::integer into v_lifetime_claimed
  from public.hookengine_subscriptions where plan='lifetime';
  select coalesce(lifetime_spot_limit,50) into v_lifetime_limit
  from public.hookengine_plans where plan_key='lifetime';

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
    'history_cutoff',v_history_cutoff,'trial_started_at',v_sub.trial_started_at,
    'trial_ends_at',v_sub.trial_ends_at,'lifetime_claimed_at',v_sub.lifetime_claimed_at,
    'total_generations',v_completed,'total_input_tokens',v_input_tokens,
    'total_output_tokens',v_output_tokens,'total_tokens',v_input_tokens+v_output_tokens,
    'credits_consumed',v_credits_consumed,'estimated_provider_cost_usd',v_provider_cost,
    'average_latency_ms',v_avg_latency,'lifetime_claimed',v_lifetime_claimed,
    'lifetime_limit',v_lifetime_limit,'lifetime_remaining',greatest(0,v_lifetime_limit-v_lifetime_claimed)
  );
end;
$$;

create or replace function public.hookengine_admin_set_plan(p_user_id uuid,p_plan text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_start timestamptz := date_trunc('week', timezone('UTC',now())) at time zone 'UTC';
  v_end timestamptz := v_start + interval '7 days';
  v_result jsonb;
  v_balance integer := 0;
  v_old public.hookengine_subscriptions%rowtype;
begin
  if p_user_id is null or p_plan is null or p_plan not in ('free','pro','trial','lifetime') then
    return jsonb_build_object('ok',false,'reason','invalid_plan');
  end if;

  if p_plan='lifetime' then
    return public.hookengine_assign_lifetime(p_user_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));
  select * into v_old from public.hookengine_subscriptions where user_id=p_user_id for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','account_not_found');
  end if;

  if v_old.credits_balance > 0 then
    insert into public.hookengine_credit_ledger(
      user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
    ) values (
      p_user_id,'period_expire',-v_old.credits_balance,0,v_old.credit_period_started_at,v_old.credit_period_ends_at,
      'admin-plan-change:'||p_user_id::text||':'||gen_random_uuid()::text,
      jsonb_build_object('previous_plan',v_old.plan,'next_plan',p_plan)
    );
  end if;

  if p_plan='trial' then
    update public.hookengine_subscriptions
    set plan='trial',status='trialing',provider=null,provider_subscription_id=null,current_period_end=null,
        trial_started_at=v_now,trial_ends_at=v_now+interval '7 days',credits_balance=40,
        credit_period_started_at=v_now,credit_period_ends_at=v_now+interval '7 days',updated_at=v_now
    where user_id=p_user_id;
    insert into public.hookengine_credit_ledger(
      user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
    ) values (
      p_user_id,'trial_grant',40,40,v_now,v_now+interval '7 days',
      'admin-trial-grant:'||p_user_id::text||':'||gen_random_uuid()::text,
      jsonb_build_object('plan','trial','trial_days',7,'admin_granted',true)
    );
  elsif p_plan='pro' then
    update public.hookengine_subscriptions
    set plan='pro',status='active',provider=null,provider_subscription_id=null,current_period_end=null,
        trial_started_at=null,trial_ends_at=null,credits_balance=0,
        credit_period_started_at=null,credit_period_ends_at=null,updated_at=v_now
    where user_id=p_user_id;
    v_result := public.hookengine_refresh_credit_period(p_user_id);
  else
    update public.hookengine_subscriptions
    set plan='free',status='inactive',provider=null,provider_subscription_id=null,current_period_end=null,
        trial_started_at=null,trial_ends_at=null,credits_balance=0,
        credit_period_started_at=null,credit_period_ends_at=null,updated_at=v_now
    where user_id=p_user_id;
  end if;

  update public.hookengine_profiles set plan=p_plan where user_id=p_user_id;
  select credits_balance into v_balance from public.hookengine_subscriptions where user_id=p_user_id;

  return jsonb_build_object(
    'ok',true,'plan',p_plan,'credits_balance',v_balance,
    'trial_ends_at',(select trial_ends_at from public.hookengine_subscriptions where user_id=p_user_id)
  );
end;
$$;

revoke all on function public.hookengine_admin_set_plan(uuid,text) from public, anon, authenticated;
grant execute on function public.hookengine_admin_set_plan(uuid,text) to service_role;


-- PayPal event idempotency and ordered subscription state transitions.
alter table public.hookengine_subscriptions
  add column if not exists paypal_last_event_at timestamptz;

create table if not exists public.hookengine_paypal_webhook_events (
  event_id text primary key,
  event_type text not null,
  subscription_id text not null,
  event_time timestamptz not null,
  outcome text not null,
  processed_at timestamptz not null default now()
);
alter table public.hookengine_paypal_webhook_events enable row level security;
revoke all on public.hookengine_paypal_webhook_events from anon, authenticated, public;
grant all on public.hookengine_paypal_webhook_events to service_role;

create or replace function public.hookengine_apply_paypal_event(
  p_event_id text,
  p_event_type text,
  p_subscription_id text,
  p_event_time timestamptz,
  p_next_billing_time timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_plan text;
  v_sub public.hookengine_subscriptions%rowtype;
  v_refresh jsonb;
begin
  if coalesce(p_event_id,'')='' or coalesce(p_subscription_id,'')='' or p_event_time is null then
    return jsonb_build_object('applied',false,'reason','invalid_event');
  end if;

  if p_event_type in ('BILLING.SUBSCRIPTION.ACTIVATED','BILLING.SUBSCRIPTION.RE-ACTIVATED') then
    v_status := 'active';
    v_plan := 'pro';
  elsif p_event_type in ('BILLING.SUBSCRIPTION.CANCELLED','BILLING.SUBSCRIPTION.EXPIRED') then
    v_status := 'cancelled';
    v_plan := 'free';
  elsif p_event_type in ('BILLING.SUBSCRIPTION.SUSPENDED','BILLING.SUBSCRIPTION.PAYMENT.FAILED') then
    v_status := 'past_due';
    v_plan := 'free';
  else
    return jsonb_build_object('applied',false,'reason','unsupported_event');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-paypal-event:'||p_event_id,0));
  if exists (select 1 from public.hookengine_paypal_webhook_events where event_id=p_event_id) then
    return jsonb_build_object('applied',false,'reason','duplicate_event');
  end if;

  select * into v_sub
  from public.hookengine_subscriptions
  where provider='paypal' and provider_subscription_id=p_subscription_id
  for update;

  if not found then
    -- Do not claim the event yet: checkout may still be saving the pending subscription row.
    -- Returning unknown_subscription lets PayPal retry safely.
    return jsonb_build_object('applied',false,'reason','unknown_subscription');
  end if;

  if v_sub.paypal_last_event_at is not null and p_event_time <= v_sub.paypal_last_event_at then
    insert into public.hookengine_paypal_webhook_events(event_id,event_type,subscription_id,event_time,outcome)
    values (p_event_id,p_event_type,p_subscription_id,p_event_time,'stale_event');
    return jsonb_build_object('applied',false,'reason','stale_event');
  end if;

  update public.hookengine_subscriptions
  set plan=v_plan,
      status=v_status,
      current_period_end=case when v_plan='pro' then coalesce(p_next_billing_time,current_period_end) else null end,
      credits_balance=0,
      credit_period_started_at=null,
      credit_period_ends_at=null,
      trial_started_at=null,
      trial_ends_at=null,
      paypal_last_event_at=p_event_time,
      updated_at=now()
  where user_id=v_sub.user_id;

  update public.hookengine_profiles set plan=v_plan where user_id=v_sub.user_id;

  if v_plan='pro' then
    v_refresh := public.hookengine_refresh_credit_period(v_sub.user_id);
  end if;

  insert into public.hookengine_paypal_webhook_events(event_id,event_type,subscription_id,event_time,outcome)
  values (p_event_id,p_event_type,p_subscription_id,p_event_time,'applied');

  return jsonb_build_object(
    'applied',true,'plan',v_plan,'status',v_status,
    'credits_balance',(select credits_balance from public.hookengine_subscriptions where user_id=v_sub.user_id)
  );
end;
$$;

revoke all on function public.hookengine_apply_paypal_event(text,text,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.hookengine_apply_paypal_event(text,text,text,timestamptz,timestamptz) to service_role;

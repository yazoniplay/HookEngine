-- Do not classify completed generations with zero recorded tokens as unpriced.
CREATE OR REPLACE FUNCTION public.hookengine_my_usage()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    count(*) filter (where g.status='completed'
      and (coalesce(g.tokens_in,g.input_tokens,0)+coalesce(g.tokens_out,g.output_tokens,0))>0
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
    'daily_reset_at',v_day_start+interval '1 day',
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
$function$

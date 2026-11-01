-- HookEngine Phase 2 correction: every regeneration costs one credit.
-- Initial full video analysis remains five credits; transcript/text generation is one.
create or replace function public.hookengine_reserve_generation(
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

  v_expected_cost := case when p_action_type='regeneration' then 1 when p_source_type='youtube_video' then 5 else 1 end;
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

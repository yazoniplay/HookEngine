\set ON_ERROR_STOP on

do $hookengine_test$
declare
  v_free_user uuid := '10000000-0000-4000-8000-000000000001';
  v_video_user uuid := '20000000-0000-4000-8000-000000000002';
  v_transcript_user uuid := '30000000-0000-4000-8000-000000000003';
  v_lifetime_user uuid := '40000000-0000-4000-8000-000000000004';
  v_second_lifetime_user uuid := '50000000-0000-4000-8000-000000000005';
  v_source text := repeat('Validated source content for HookEngine integration tests. ', 2);
  v_other_source text := repeat('Different source content that must not be accepted for regeneration. ', 2);
  v_result jsonb;
  v_root uuid;
  v_regeneration uuid;
  v_video_root uuid;
  v_failed_video uuid;
  v_video_regeneration uuid;
  v_balance integer;
  v_event_time timestamptz;
begin
  insert into auth.users(id,email) values
    (v_free_user,'free-test@example.invalid'),
    (v_video_user,'video-test@example.invalid'),
    (v_transcript_user,'transcript-test@example.invalid'),
    (v_lifetime_user,'lifetime-customer-fixture@example.test'),
    (v_second_lifetime_user,'second-lifetime-customer-fixture@example.test');

  insert into public.hookengine_internal_accounts(user_id,reason) values
    (v_free_user,'CI test fixture'),
    (v_video_user,'CI test fixture'),
    (v_transcript_user,'CI test fixture');

  if not (select relrowsecurity from pg_class where oid='public.hookengine_admin_audit'::regclass) then
    raise exception 'Admin audit table must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.hookengine_admin_audit','INSERT')
     or has_table_privilege('authenticated','public.hookengine_admin_audit','INSERT')
     or not has_table_privilege('service_role','public.hookengine_admin_audit','INSERT') then
    raise exception 'Admin audit table grants are not service-role-only';
  end if;

  if not exists (
    select 1 from public.hookengine_subscriptions
    where user_id=v_free_user and plan='trial' and status='trialing' and credits_balance=40
  ) then
    raise exception 'New signup did not receive the expected trial entitlement';
  end if;

  update public.hookengine_subscriptions
  set plan='free',status='inactive',credits_balance=5,
      credit_period_started_at=date_trunc('week',timezone('UTC',now())) at time zone 'UTC',
      credit_period_ends_at=(date_trunc('week',timezone('UTC',now())) + interval '7 days') at time zone 'UTC'
  where user_id=v_free_user;
  update public.hookengine_profiles set plan='free' where user_id=v_free_user;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'unsupported_source','Invalid','','', 'generation',null,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'invalid_source_type' then
    raise exception 'Unsupported source type was not rejected: %',v_result;
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Free root','',v_source,'generation',null,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Free root generation was denied: %',v_result;
  end if;
  if (v_result->>'credits_reserved')::integer <> 1 then
    raise exception 'Article generation must reserve 1 credit: %',v_result;
  end if;
  v_root := (v_result->>'generation_id')::uuid;
  if (select source_text from public.hookengine_generations where id=v_root) is not null then
    raise exception 'Source text must never be persisted';
  end if;
  if (select source_hash from public.hookengine_generations where id=v_root)
      is distinct from encode(extensions.digest(convert_to(v_source,'UTF8'),'sha256'),'hex') then
    raise exception 'Source SHA-256 fingerprint was not persisted correctly';
  end if;
  if (select source_length from public.hookengine_generations where id=v_root) <> char_length(v_source) then
    raise exception 'Source length was not persisted correctly';
  end if;

  if not public.hookengine_finish_generation(
    p_generation_id=>v_root,p_user_id=>v_free_user,p_status=>'completed',
    p_outputs=>'{"x_thread":"root draft"}'::jsonb,p_selected_platforms=>array['x_thread']::text[]
  ) then
    raise exception 'Could not finalize Free root generation';
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Free root','',v_source,'regeneration',v_root,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'First Free regeneration was denied: %',v_result;
  end if;
  if (v_result->>'credits_reserved')::integer <> 1 then
    raise exception 'Article regeneration must reserve 1 credit: %',v_result;
  end if;
  v_regeneration := (v_result->>'generation_id')::uuid;

  if not public.hookengine_finish_generation(
    p_generation_id=>v_regeneration,p_user_id=>v_free_user,p_status=>'completed',
    p_outputs=>'{"x_thread":"regenerated draft"}'::jsonb,p_selected_platforms=>array['x_thread']::text[]
  ) then
    raise exception 'Could not finalize Free regeneration';
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Nested attempt','',v_source,'regeneration',v_regeneration,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'invalid_regeneration_parent' then
    raise exception 'Nested regeneration was not rejected: %',v_result;
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Second attempt','',v_source,'regeneration',v_root,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'regeneration_limit_reached' then
    raise exception 'Free per-source regeneration limit was not enforced: %',v_result;
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Changed source','',v_other_source,'regeneration',v_root,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'regeneration_source_mismatch' then
    raise exception 'Regeneration accepted a different source: %',v_result;
  end if;

  v_result := public.hookengine_reserve_generation(
    v_free_user,'article','Refund test','',v_source,'generation',null,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Refund test reservation was denied: %',v_result;
  end if;
  v_root := (v_result->>'generation_id')::uuid;
  select credits_balance into v_balance from public.hookengine_subscriptions where user_id=v_free_user;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_root,p_user_id=>v_free_user,p_status=>'failed',p_error_message=>'integration test failure'
  ) then
    raise exception 'Could not finalize failed reservation';
  end if;
  if (select credits_balance from public.hookengine_subscriptions where user_id=v_free_user) <> v_balance + 1 then
    raise exception 'Failed generation did not refund its reserved credit';
  end if;

  update public.hookengine_subscriptions
  set plan='pro',status='active',credits_balance=20,current_period_end=now()+interval '30 days',
      credit_period_started_at=date_trunc('month',timezone('UTC',now())) at time zone 'UTC',
      credit_period_ends_at=(date_trunc('month',timezone('UTC',now())) + interval '1 month') at time zone 'UTC'
  where user_id=v_video_user;
  update public.hookengine_profiles set plan='pro' where user_id=v_video_user;

  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Video root','https://www.youtube.com/watch?v=integration-test','',
    'generation',null,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Pro video generation was denied: %',v_result;
  end if;
  if (v_result->>'credits_reserved')::integer <> 5 then
    raise exception 'Video analysis must reserve 5 credits: %',v_result;
  end if;
  v_video_root := (v_result->>'generation_id')::uuid;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_video_root,p_user_id=>v_video_user,p_status=>'completed',
    p_outputs=>'{"x_thread":"video draft"}'::jsonb,p_selected_platforms=>array['x_thread']::text[]
  ) then
    raise exception 'Could not finalize Pro video generation';
  end if;

  -- A failed 5-credit video analysis must restore all five reserved credits.
  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Failed video refund','https://www.youtube.com/watch?v=failed-video-test','',
    'generation',null,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false)
     or (v_result->>'credits_reserved')::integer <> 5 then
    raise exception 'Video failure refund test did not reserve five credits: %',v_result;
  end if;
  v_failed_video := (v_result->>'generation_id')::uuid;
  select credits_balance into v_balance from public.hookengine_subscriptions where user_id=v_video_user;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_failed_video,p_user_id=>v_video_user,p_status=>'failed',p_error_message=>'forced video failure test'
  ) then
    raise exception 'Could not finalize failed video reservation';
  end if;
  if (select credits_balance from public.hookengine_subscriptions where user_id=v_video_user) <> v_balance + 5
     or (select refunded_at from public.hookengine_generations where id=v_failed_video) is null then
    raise exception 'Failed 5-credit video reservation was not fully refunded';
  end if;

  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Video root','https://www.youtube.com/watch?v=integration-test','',
    'regeneration',v_video_root,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Pro video regeneration was denied: %',v_result;
  end if;
  if (v_result->>'credits_reserved')::integer <> 1 then
    raise exception 'Video regeneration must reserve 1 credit: %',v_result;
  end if;
  v_video_regeneration := (v_result->>'generation_id')::uuid;
  if (select credits_balance from public.hookengine_subscriptions where user_id=v_video_user) <> 14 then
    raise exception 'Video generation (5) plus regeneration (1) should consume exactly 6 credits';
  end if;

  update public.hookengine_subscriptions set credits_balance=4 where user_id=v_video_user;
  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Insufficient credits','https://www.youtube.com/watch?v=another-test','',
    'generation',null,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'monthly_limit' or (v_result->>'credits_required')::integer <> 5 then
    raise exception 'Video request with 4 credits should be refused with a 5-credit requirement: %',v_result;
  end if;

  -- Verify the provider telemetry is stored and surfaced through the authenticated usage RPC.
  update public.hookengine_subscriptions
  set credits_balance=20
  where user_id=v_video_user;
  v_result := public.hookengine_reserve_generation(
    v_video_user,'article','Telemetry test','',v_source,'generation',null,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Telemetry test reservation was denied: %',v_result;
  end if;
  v_root := (v_result->>'generation_id')::uuid;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_root,p_user_id=>v_video_user,p_status=>'completed',
    p_outputs=>'{"x_thread":"telemetry draft"}'::jsonb,p_selected_platforms=>array['x_thread']::text[],
    p_provider=>'Gemini',p_model=>'gemini-3.5-flash-lite',p_input_tokens=>100,p_output_tokens=>200,p_latency_ms=>1250,p_source_seconds=>60.0
  ) then
    raise exception 'Could not finalize telemetry generation';
  end if;
  perform set_config('request.jwt.claim.sub',v_video_user::text,true);
  v_result := public.hookengine_get_usage();
  if (v_result->>'total_tokens')::bigint <> 300
     or (select tokens_in from public.hookengine_generations where id=v_root) <> 100
     or (select tokens_out from public.hookengine_generations where id=v_root) <> 200
     or (select source_seconds from public.hookengine_generations where id=v_root) <> 60.0
     or (v_result->>'credits_consumed')::bigint <> 6
     or (v_result->>'estimated_provider_cost_usd')::numeric <= 0 then
    raise exception 'Usage RPC did not return token, credit and provider cost metrics: %',v_result;
  end if;

  -- Zero-token telemetry with no model must not be counted as an unpriced generation.
  v_result := public.hookengine_reserve_generation(
    v_video_user,'article','Zero-token telemetry test','',v_source,'generation',null,array['x_thread']::text[]
  );
  v_root := (v_result->>'generation_id')::uuid;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_root,p_user_id=>v_video_user,p_status=>'completed',
    p_outputs=>'{"x_thread":"zero token test"}'::jsonb,p_selected_platforms=>array['x_thread']::text[],
    p_provider=>'Gemini',p_model=>null,p_input_tokens=>0,p_output_tokens=>0,p_latency_ms=>1
  ) then
    raise exception 'Could not finalize zero-token telemetry test';
  end if;
  v_result := public.hookengine_my_usage();
  if (v_result->>'unpriced_generations')::integer <> 0 then
    raise exception 'Zero-token row incorrectly counted as unpriced: %',v_result;
  end if;

  -- PayPal activation grants the Pro period once; duplicates and out-of-order events are ignored.
  update public.hookengine_subscriptions
  set provider='paypal',provider_subscription_id='I-TEST-SUBSCRIPTION',
      plan='pro',status='inactive',credits_balance=12,
      credit_period_started_at=date_trunc('week',timezone('UTC',now())) at time zone 'UTC',
      credit_period_ends_at=(date_trunc('week',timezone('UTC',now())) + interval '7 days') at time zone 'UTC'
  where user_id=v_video_user;
  v_event_time := now();
  v_result := public.hookengine_apply_paypal_event(
    'evt-hookengine-activated','BILLING.SUBSCRIPTION.ACTIVATED','I-TEST-SUBSCRIPTION',
    v_event_time,v_event_time+interval '30 days'
  );
  if not coalesce((v_result->>'applied')::boolean,false)
     or (select plan from public.hookengine_subscriptions where user_id=v_video_user) <> 'pro'
     or (select credits_balance from public.hookengine_subscriptions where user_id=v_video_user) <> 300 then
    raise exception 'PayPal activation did not grant the Pro monthly credits: %',v_result;
  end if;
  v_result := public.hookengine_apply_paypal_event(
    'evt-hookengine-activated','BILLING.SUBSCRIPTION.ACTIVATED','I-TEST-SUBSCRIPTION',
    v_event_time,v_event_time+interval '30 days'
  );
  if v_result->>'reason' is distinct from 'duplicate_event' then
    raise exception 'Duplicate PayPal event was not ignored: %',v_result;
  end if;

  v_result := public.hookengine_apply_paypal_event(
    'evt-hookengine-cancelled','BILLING.SUBSCRIPTION.CANCELLED','I-TEST-SUBSCRIPTION',
    v_event_time+interval '2 seconds',null
  );
  if not coalesce((v_result->>'applied')::boolean,false)
     or (select plan from public.hookengine_subscriptions where user_id=v_video_user) <> 'free'
     or (select credits_balance from public.hookengine_subscriptions where user_id=v_video_user) <> 0 then
    raise exception 'PayPal cancellation did not downgrade and clear Pro credits: %',v_result;
  end if;
  v_result := public.hookengine_apply_paypal_event(
    'evt-hookengine-stale-activation','BILLING.SUBSCRIPTION.ACTIVATED','I-TEST-SUBSCRIPTION',
    v_event_time+interval '1 second',v_event_time+interval '31 days'
  );
  if v_result->>'reason' is distinct from 'stale_event'
     or (select plan from public.hookengine_subscriptions where user_id=v_video_user) <> 'free' then
    raise exception 'Out-of-order PayPal event changed the current plan: %',v_result;
  end if;

  -- Existing accounts can be granted a fresh trial by the authenticated admin endpoint.
  v_result := public.hookengine_admin_set_plan(v_free_user,'trial');
  if not coalesce((v_result->>'ok')::boolean,false)
     or (select plan from public.hookengine_subscriptions where user_id=v_free_user) <> 'trial'
     or (select credits_balance from public.hookengine_subscriptions where user_id=v_free_user) <> 40 then
    raise exception 'Admin trial assignment failed: %',v_result;
  end if;

  v_result := public.hookengine_admin_set_plan(v_free_user,'lifetime');
  if v_result->>'reason' is distinct from 'internal_account'
     or (select plan from public.hookengine_subscriptions where user_id=v_free_user) = 'lifetime'
     or (select lifetime_claimed_at from public.hookengine_subscriptions where user_id=v_free_user) is not null then
    raise exception 'Internal CI account must not consume a Lifetime spot: %',v_result;
  end if;

  update public.hookengine_plans set lifetime_spot_limit=1 where plan_key='lifetime';
  v_result := public.hookengine_admin_set_plan(v_lifetime_user,'lifetime');
  if not coalesce((v_result->>'assigned')::boolean,false)
     or (select plan from public.hookengine_subscriptions where user_id=v_lifetime_user) <> 'lifetime' then
    raise exception 'Eligible Lifetime customer fixture could not claim a spot: %',v_result;
  end if;
  v_result := public.hookengine_admin_set_plan(v_second_lifetime_user,'lifetime');
  if v_result->>'reason' is distinct from 'sold_out' then
    raise exception 'Lifetime spot cap was not enforced: %',v_result;
  end if;
  update public.hookengine_plans set lifetime_spot_limit=50 where plan_key='lifetime';

end;
$hookengine_test$;

select 'HookEngine PostgreSQL migration and entitlement tests passed' as result;


-- Transcript-first requests cost one credit on Free; the source is hashed but not stored.
update public.hookengine_subscriptions
set plan='free',status='inactive',credits_balance=5,
    credit_period_started_at=date_trunc('week',timezone('UTC',now())) at time zone 'UTC',
    credit_period_ends_at=(date_trunc('week',timezone('UTC',now()))+interval '7 days') at time zone 'UTC'
where user_id='30000000-0000-4000-8000-000000000003';
update public.hookengine_profiles set plan='free' where user_id='30000000-0000-4000-8000-000000000003';

do $hookengine_phase2_contract$
declare
  v_user uuid := '30000000-0000-4000-8000-000000000003';
  v_source text := 'A transcript-first test source.';
  v_result jsonb;
  v_id uuid;
  v_usage jsonb;
  i integer;
begin
  v_result := public.hookengine_reserve_generation(
    v_user,'youtube_transcript','Transcript test','https://www.youtube.com/watch?v=transcript-test',
    v_source,'generation',null,array['x_thread']::text[],1
  );
  if not coalesce((v_result->>'allowed')::boolean,false)
     or (v_result->>'credits_reserved')::integer<>1 then
    raise exception 'Transcript source must cost one credit: %',v_result;
  end if;
  v_id := (v_result->>'generation_id')::uuid;
  if (select source_text from public.hookengine_generations where id=v_id) is not null then
    raise exception 'Transcript source text was persisted';
  end if;
  if not public.hookengine_finish_generation(
    p_generation_id=>v_id,p_user_id=>v_user,p_status=>'failed',p_error_message=>'refund test'
  ) then
    raise exception 'Transcript reservation could not be finalized';
  end if;

  update public.hookengine_subscriptions set credits_balance=0 where user_id=v_user;
  v_result := public.hookengine_reserve_generation(
    v_user,'article','Weekly cap test','',v_source,'generation',null,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'weekly_limit' then
    raise exception 'Free credit exhaustion must return weekly_limit: %',v_result;
  end if;
  if position('Weekly pool exhausted. Resets at ' in coalesce(v_result->>'message',''))=0
     or v_result->>'reset_at' is null then
    raise exception 'Weekly limit must include its name and exact reset timestamp: %',v_result;
  end if;

  update public.hookengine_subscriptions set credits_balance=5 where user_id=v_user;
  for i in 1..3 loop
    v_result := public.hookengine_reserve_generation(
      v_user,'article','Daily cap test','',v_source,'generation',null,array['x_thread']::text[]
    );
    if not coalesce((v_result->>'allowed')::boolean,false) then
      raise exception 'Allowed daily generation % was refused: %',i,v_result;
    end if;
    v_id := (v_result->>'generation_id')::uuid;
    if not public.hookengine_finish_generation(
      p_generation_id=>v_id,p_user_id=>v_user,p_status=>'completed',
      p_outputs=>'{"x_thread":"daily cap test"}'::jsonb,p_selected_platforms=>array['x_thread']::text[]
    ) then
      raise exception 'Daily cap test generation % could not be finalized',i;
    end if;
  end loop;
  v_result := public.hookengine_reserve_generation(
    v_user,'article','Daily cap exceeded','',v_source,'generation',null,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'daily_cap' then
    raise exception 'Fourth daily generation must return daily_cap: %',v_result;
  end if;
  if position('Daily cap reached (3/3). Resets at ' in coalesce(v_result->>'message',''))=0
     or v_result->>'reset_at' is null then
    raise exception 'Daily cap must include its name and exact reset timestamp: %',v_result;
  end if;
end;
$hookengine_phase2_contract$;

-- Verify the browser role can read its own usage but cannot execute write RPCs.
set request.jwt.claim.sub = '30000000-0000-4000-8000-000000000003';
set role authenticated;
do $hookengine_invoker_test$
declare
  v_usage jsonb;
  v_legacy jsonb;
begin
  if (select prosecdef from pg_proc where oid='public.hookengine_my_usage()'::regprocedure) then
    raise exception 'hookengine_my_usage must be SECURITY INVOKER';
  end if;
  if has_function_privilege('authenticated',
      'public.hookengine_reserve_generation(uuid,text,text,text,text,text,uuid,text[],integer)'::regprocedure,'EXECUTE') then
    raise exception 'Authenticated users must not execute reservation RPC';
  end if;
  if has_table_privilege('authenticated','public.hookengine_subscriptions','UPDATE') then
    raise exception 'Authenticated users must not write subscriptions';
  end if;
  if (select prosecdef from pg_proc where oid='public.hookengine_get_usage()'::regprocedure) then
    raise exception 'Legacy usage RPC must also be SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated','public.hookengine_get_usage()'::regprocedure,'EXECUTE') then
    raise exception 'Published extension compatibility RPC is not executable by authenticated users';
  end if;
  v_usage := public.hookengine_my_usage();
  v_legacy := public.hookengine_get_usage();
  if v_legacy->>'plan' is distinct from v_usage->>'plan' then
    raise exception 'Legacy usage RPC wrapper does not match canonical usage RPC';
  end if;
  if v_usage->>'plan' is distinct from 'free'
     or (v_usage->>'credits_total')::integer<>5
     or (v_usage->>'daily_limit')::integer<>3
     or v_usage->>'reset_at' is null or v_usage->>'daily_reset_at' is null then
    raise exception 'SECURITY INVOKER usage RPC returned incorrect plan limits: %',v_usage;
  end if;
  if (select count(*) from public.hookengine_subscriptions
      where user_id='20000000-0000-4000-8000-000000000002')<>0 then
    raise exception 'RLS exposed another user subscription';
  end if;
end;
$hookengine_invoker_test$;
reset role;

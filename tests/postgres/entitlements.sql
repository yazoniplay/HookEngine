\set ON_ERROR_STOP on

do $$
declare
  v_free_user uuid := '10000000-0000-4000-8000-000000000001';
  v_video_user uuid := '20000000-0000-4000-8000-000000000002';
  v_source text := repeat('Validated source content for HookEngine integration tests. ', 2);
  v_other_source text := repeat('Different source content that must not be accepted for regeneration. ', 2);
  v_result jsonb;
  v_root uuid;
  v_regeneration uuid;
  v_video_root uuid;
  v_video_regeneration uuid;
  v_balance integer;
begin
  insert into auth.users(id,email) values
    (v_free_user,'free-test@example.invalid'),
    (v_video_user,'video-test@example.invalid');

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

  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Video root','https://www.youtube.com/watch?v=integration-test','',
    'regeneration',v_video_root,array['x_thread']::text[]
  );
  if not coalesce((v_result->>'allowed')::boolean,false) then
    raise exception 'Pro video regeneration was denied: %',v_result;
  end if;
  if (v_result->>'credits_reserved')::integer <> 5 then
    raise exception 'Video regeneration must reserve 5 credits: %',v_result;
  end if;
  v_video_regeneration := (v_result->>'generation_id')::uuid;
  if (select credits_balance from public.hookengine_subscriptions where user_id=v_video_user) <> 10 then
    raise exception 'Video generation plus regeneration should consume exactly 10 credits';
  end if;

  update public.hookengine_subscriptions set credits_balance=4 where user_id=v_video_user;
  v_result := public.hookengine_reserve_generation(
    v_video_user,'youtube_video','Insufficient credits','https://www.youtube.com/watch?v=another-test','',
    'generation',null,array['x_thread']::text[]
  );
  if v_result->>'reason' is distinct from 'insufficient_credits' or (v_result->>'credits_required')::integer <> 5 then
    raise exception 'Video request with 4 credits should be refused with a 5-credit requirement: %',v_result;
  end if;
end;
$$;

select 'HookEngine PostgreSQL migration and entitlement tests passed' as result;

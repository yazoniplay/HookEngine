-- Prevent internal/admin/test identities from consuming scarce Lifetime spots.
create table if not exists public.hookengine_internal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.hookengine_internal_accounts enable row level security;
revoke all on table public.hookengine_internal_accounts from anon, authenticated;
grant all on table public.hookengine_internal_accounts to service_role;

-- Durable audit trail for privileged plan-management requests.
create table if not exists public.hookengine_admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  target_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  requested_plan text,
  outcome text not null,
  http_status integer,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists hookengine_admin_audit_created_at_idx
  on public.hookengine_admin_audit(created_at desc);
alter table public.hookengine_admin_audit enable row level security;
revoke all on table public.hookengine_admin_audit from anon, authenticated;
grant all on table public.hookengine_admin_audit to service_role;

-- The product-owner account is an internal identity, never a customer Lifetime claimant.
insert into public.hookengine_internal_accounts(user_id,reason)
select id,'Product owner/admin account; excluded from customer Lifetime allocation'
from auth.users where id='79668c58-8676-4439-a440-03482afd7717'
on conflict (user_id) do update set reason=excluded.reason;

-- Reclaim the incorrectly consumed spot. Historical ledger rows remain as an audit trail.
update public.hookengine_subscriptions
set lifetime_claimed_at=null,updated_at=now()
where user_id in (select user_id from public.hookengine_internal_accounts
                  where user_id='79668c58-8676-4439-a440-03482afd7717');

create or replace function public.hookengine_assign_lifetime(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer;
  v_claimed integer;
  v_old_balance integer := 0;
  v_old_period_started_at timestamptz;
  v_old_period_ends_at timestamptz;
  v_previously_claimed boolean := false;
  v_internal boolean := false;
  v_start timestamptz := date_trunc('month', timezone('UTC',now())) at time zone 'UTC';
  v_end timestamptz := (date_trunc('month', timezone('UTC',now())) + interval '1 month') at time zone 'UTC';
begin
  perform pg_advisory_xact_lock(hashtextextended('hookengine-lifetime-claims',0));
  perform pg_advisory_xact_lock(hashtextextended('hookengine-user:'||p_user_id::text,0));

  select lifetime_claimed_at is not null into v_previously_claimed
  from public.hookengine_subscriptions where user_id=p_user_id;
  if not found then
    return jsonb_build_object('assigned',false,'reason','account_not_found');
  end if;

  select
    exists (select 1 from public.hookengine_internal_accounts i where i.user_id=p_user_id)
    or exists (select 1 from auth.users u where u.id=p_user_id and lower(coalesce(u.email,'')) like '%@hookengine.invalid')
  into v_internal;
  if v_internal then
    return jsonb_build_object('assigned',false,'reason','internal_account');
  end if;

  if exists (select 1 from public.hookengine_subscriptions where user_id=p_user_id and plan='lifetime') then
    return jsonb_build_object('assigned',false,'reason','already_lifetime');
  end if;
  select lifetime_spot_limit into v_limit from public.hookengine_plans where plan_key='lifetime';
  select count(*)::integer into v_claimed
  from public.hookengine_subscriptions where lifetime_claimed_at is not null;
  if not v_previously_claimed and v_claimed >= coalesce(v_limit,50) then
    return jsonb_build_object('assigned',false,'reason','sold_out','claimed',v_claimed,'limit',v_limit);
  end if;

  select credits_balance,credit_period_started_at,credit_period_ends_at
  into v_old_balance,v_old_period_started_at,v_old_period_ends_at
  from public.hookengine_subscriptions where user_id=p_user_id for update;
  if not found then
    return jsonb_build_object('assigned',false,'reason','account_not_found');
  end if;

  if v_old_balance > 0 then
    insert into public.hookengine_credit_ledger(
      user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
    ) values (
      p_user_id,'period_expire',-v_old_balance,0,v_old_period_started_at,v_old_period_ends_at,
      'lifetime-conversion-expire:'||p_user_id::text,
      jsonb_build_object('reason','plan_conversion','target_plan','lifetime')
    ) on conflict (idempotency_key) do nothing;
  end if;

  update public.hookengine_subscriptions
  set plan='lifetime',status='active',provider='manual',provider_subscription_id=null,
      current_period_end=null,lifetime_claimed_at=coalesce(lifetime_claimed_at,now()),
      credits_balance=150,credit_period_started_at=v_start,credit_period_ends_at=v_end,updated_at=now()
  where user_id=p_user_id;
  if not found then
    return jsonb_build_object('assigned',false,'reason','account_not_found');
  end if;

  update public.hookengine_profiles set plan='lifetime' where user_id=p_user_id;
  insert into public.hookengine_credit_ledger(
    user_id,entry_type,amount,balance_after,period_started_at,period_ends_at,idempotency_key,metadata
  ) values (
    p_user_id,'admin_adjustment',150,150,v_start,v_end,
    'lifetime-initial-grant:'||p_user_id::text,jsonb_build_object('plan','lifetime')
  ) on conflict (idempotency_key) do nothing;

  return jsonb_build_object('assigned',true,'plan','lifetime','credits_balance',150,
    'claimed',v_claimed+case when v_previously_claimed then 0 else 1 end,'limit',v_limit);
end;
$function$;

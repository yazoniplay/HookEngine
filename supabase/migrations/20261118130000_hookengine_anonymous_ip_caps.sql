-- Anonymous generation caps. Additive only: the existing account-based reservation
-- functions are not changed, so already-published extension builds keep working.
-- Buckets are either 'global' (all anonymous users per UTC day) or a salted SHA-256
-- hash of a client IP. Raw IP addresses are never stored.

create table public.hookengine_anonymous_usage (
  bucket text not null,
  usage_day date not null,
  generations integer not null default 0 check (generations >= 0),
  primary key (bucket, usage_day)
);

alter table public.hookengine_anonymous_usage enable row level security;
revoke all on table public.hookengine_anonymous_usage from public, anon, authenticated;

create or replace function public.hookengine_reserve_anonymous(
  p_ip_hash text,
  p_ip_limit integer,
  p_global_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_day date := (pg_catalog.now() at time zone 'utc')::date;
  v_resets_at timestamptz := ((v_day + 1)::timestamp at time zone 'utc');
  v_global integer;
  v_ip integer;
begin
  if p_ip_hash is null or pg_catalog.char_length(p_ip_hash) <> 64 then
    raise exception 'invalid_ip_bucket' using errcode = '22023';
  end if;
  if p_ip_limit is null or p_ip_limit < 1 or p_global_limit is null or p_global_limit < 1 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  insert into public.hookengine_anonymous_usage(bucket, usage_day) values ('global', v_day)
  on conflict (bucket, usage_day) do nothing;
  insert into public.hookengine_anonymous_usage(bucket, usage_day) values (p_ip_hash, v_day)
  on conflict (bucket, usage_day) do nothing;

  select generations into v_global from public.hookengine_anonymous_usage
   where bucket = 'global' and usage_day = v_day for update;
  select generations into v_ip from public.hookengine_anonymous_usage
   where bucket = p_ip_hash and usage_day = v_day for update;

  if v_global >= p_global_limit then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'global_limit', 'resets_at', v_resets_at);
  end if;
  if v_ip >= p_ip_limit then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'ip_limit', 'resets_at', v_resets_at);
  end if;

  update public.hookengine_anonymous_usage set generations = generations + 1
   where bucket in ('global', p_ip_hash) and usage_day = v_day;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'ip_remaining', p_ip_limit - v_ip - 1,
    'global_remaining', p_global_limit - v_global - 1,
    'resets_at', v_resets_at
  );
end;
$function$;

create or replace function public.hookengine_refund_anonymous(p_ip_hash text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_day date := (pg_catalog.now() at time zone 'utc')::date;
begin
  update public.hookengine_anonymous_usage
     set generations = greatest(0, generations - 1)
   where bucket in ('global', p_ip_hash) and usage_day = v_day;
end;
$function$;

create or replace function public.hookengine_prune_anonymous_usage()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_deleted integer;
begin
  delete from public.hookengine_anonymous_usage
   where usage_day < ((pg_catalog.now() at time zone 'utc')::date - 2);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.hookengine_reserve_anonymous(text, integer, integer) from public, anon, authenticated;
revoke all on function public.hookengine_refund_anonymous(text) from public, anon, authenticated;
revoke all on function public.hookengine_prune_anonymous_usage() from public, anon, authenticated;
grant execute on function public.hookengine_reserve_anonymous(text, integer, integer) to service_role;
grant execute on function public.hookengine_refund_anonymous(text) to service_role;
grant execute on function public.hookengine_prune_anonymous_usage() to service_role;

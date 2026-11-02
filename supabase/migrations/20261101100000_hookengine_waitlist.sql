-- Public waitlist submissions are insert-only. Reads and mutations stay server-side.
create table public.hookengine_waitlist (
  email text primary key,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1)
);

alter table public.hookengine_waitlist enable row level security;

create policy "Anonymous can submit waitlist entries"
on public.hookengine_waitlist
for insert
to anon
with check (true);

revoke all on table public.hookengine_waitlist from public, anon, authenticated;
grant insert on table public.hookengine_waitlist to anon;
revoke select on table public.hookengine_waitlist from anon, authenticated;
revoke update on table public.hookengine_waitlist from anon, authenticated;
revoke delete on table public.hookengine_waitlist from anon, authenticated;

create or replace function public.hookengine_waitlist_guard_insert()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_email text;
  v_attempt_count integer;
  v_last_attempt_at timestamptz;
begin
  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(new.email, '')));
  if pg_catalog.char_length(v_email) < 6
     or pg_catalog.char_length(v_email) > 254
     or v_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hookengine-waitlist:' || v_email, 0)
  );

  select attempt_count, last_attempt_at
    into v_attempt_count, v_last_attempt_at
    from public.hookengine_waitlist
   where email = v_email
   for update;

  if found then
    if v_last_attempt_at > pg_catalog.now() - interval '24 hours'
       and v_attempt_count >= 3 then
      raise exception 'waitlist_rate_limited' using errcode = 'P0001';
    end if;

    update public.hookengine_waitlist
       set attempt_count = case
             when v_last_attempt_at <= pg_catalog.now() - interval '24 hours' then 1
             else v_attempt_count + 1
           end,
           last_attempt_at = pg_catalog.now()
     where email = v_email;
    return null;
  end if;

  new.email := v_email;
  new.created_at := pg_catalog.now();
  new.last_attempt_at := pg_catalog.now();
  new.attempt_count := 1;
  return new;
end;
$function$;

create trigger hookengine_waitlist_guard_insert
before insert on public.hookengine_waitlist
for each row execute function public.hookengine_waitlist_guard_insert();

revoke all on function public.hookengine_waitlist_guard_insert() from public, anon, authenticated;

create or replace function public.hookengine_join_waitlist(p_email text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_email text;
begin
  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  if pg_catalog.char_length(v_email) < 6
     or pg_catalog.char_length(v_email) > 254
     or v_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  insert into public.hookengine_waitlist(email)
  values (v_email)
  on conflict (email) do nothing;

  if found then
    return pg_catalog.jsonb_build_object('status', 'joined');
  end if;
  return pg_catalog.jsonb_build_object('status', 'already_joined');
end;
$function$;

revoke all on function public.hookengine_join_waitlist(text) from public, anon, authenticated;
grant execute on function public.hookengine_join_waitlist(text) to anon;

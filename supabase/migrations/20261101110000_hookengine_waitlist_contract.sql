-- Keep public responses indistinguishable for new and existing waitlist addresses.
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

  return pg_catalog.jsonb_build_object('status', 'submitted');
end;
$function$;

revoke all on function public.hookengine_join_waitlist(text) from public, anon, authenticated;
grant execute on function public.hookengine_join_waitlist(text) to anon;

-- Deletion is an operator action, not a public endpoint keyed only by an email address.
create or replace function public.hookengine_remove_waitlist_entry(p_email text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_deleted integer;
begin
  delete from public.hookengine_waitlist
   where email = pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$function$;

revoke all on function public.hookengine_remove_waitlist_entry(text) from public, anon, authenticated;
grant execute on function public.hookengine_remove_waitlist_entry(text) to service_role;

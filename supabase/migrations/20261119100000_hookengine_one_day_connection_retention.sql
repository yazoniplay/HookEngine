-- Connection-hash rows are kept for one day: only the current UTC day's counters remain.
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
   where usage_day < (pg_catalog.now() at time zone 'utc')::date;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.hookengine_prune_anonymous_usage() from public, anon, authenticated;
grant execute on function public.hookengine_prune_anonymous_usage() to service_role;

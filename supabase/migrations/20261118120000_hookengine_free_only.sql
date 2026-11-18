-- HookEngine is free-only. Every account resolves to the free plan.
-- Existing paid-plan rows are reset to 'free'; no generation, ledger or history rows are deleted.
-- Applied migrations are not edited: this file adds a guard that keeps paid plans from being set again.

update public.hookengine_profiles
   set plan = 'free'
 where plan is distinct from 'free';

create or replace function public.hookengine_force_free_plan()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  new.plan := 'free';
  return new;
end;
$function$;

revoke all on function public.hookengine_force_free_plan() from public, anon, authenticated;

drop trigger if exists hookengine_profiles_force_free_plan on public.hookengine_profiles;
create trigger hookengine_profiles_force_free_plan
before insert or update of plan on public.hookengine_profiles
for each row execute function public.hookengine_force_free_plan();

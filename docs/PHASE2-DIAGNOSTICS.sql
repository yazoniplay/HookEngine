-- HookEngine Phase 2 production diagnostics.
-- Run in Supabase SQL Editor after applying the Phase 2 spec-alignment migration.

-- 1. RLS must be enabled on every HookEngine table.
select tablename, rowsecurity
from pg_tables
where schemaname='public' and tablename like 'hookengine_%'
order by tablename;

-- 2. Review the complete row-policy surface.
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename like 'hookengine_%'
order by tablename, policyname;

-- 3. Browser roles must not write billing/generation state or execute server-only RPCs.
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public' and table_name like 'hookengine_%'
  and grantee in ('anon','authenticated')
order by table_name,grantee,privilege_type;

select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('public',p.oid,'EXECUTE') as public_execute,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
       p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'hookengine_%'
order by p.proname;

-- 4. Verify the invoker RPC and privacy/telemetry columns.
select p.prosecdef as my_usage_is_security_definer
from pg_proc p
where p.oid='public.hookengine_my_usage()'::regprocedure;

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='hookengine_generations'
  and column_name in ('source_text','source_hash','source_length','tokens_in','tokens_out',
                      'source_seconds','latency_ms','cost_units','provider','source_type')
order by column_name;

select count(*) as rows_still_containing_source_text
from public.hookengine_generations
where source_text is not null;

-- 5. Verify scheduled maintenance jobs.
select jobname, schedule, active, command
from cron.job
where jobname like 'hookengine%'
order by jobname;

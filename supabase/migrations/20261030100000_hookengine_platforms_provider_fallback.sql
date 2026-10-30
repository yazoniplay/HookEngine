-- Extend HookEngine generation history for Pro platform drafts and provider transparency.
alter table public.hookengine_generations
  add column if not exists outputs jsonb not null default '{}'::jsonb,
  add column if not exists selected_platforms text[] not null default array['x_thread','linkedin_post','tiktok_hooks']::text[],
  add column if not exists provider text;

create or replace function public.hookengine_finish_generation(
  p_generation_id uuid,
  p_user_id uuid,
  p_status text,
  p_x_thread text default null,
  p_linkedin_post text default null,
  p_tiktok_hooks text default null,
  p_error_message text default null,
  p_outputs jsonb default '{}'::jsonb,
  p_selected_platforms text[] default array[]::text[],
  p_provider text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('completed','failed') then return false; end if;
  update public.hookengine_generations
  set status = p_status,
      x_thread = case when p_status = 'completed' then p_x_thread else null end,
      linkedin_post = case when p_status = 'completed' then p_linkedin_post else null end,
      tiktok_hooks = case when p_status = 'completed' then p_tiktok_hooks else null end,
      outputs = case when p_status = 'completed' then coalesce(p_outputs,'{}'::jsonb) else '{}'::jsonb end,
      selected_platforms = case when p_status = 'completed' then coalesce(p_selected_platforms,array[]::text[]) else array[]::text[] end,
      provider = case when p_status = 'completed' then left(p_provider,40) else null end,
      error_message = case when p_status = 'failed' then left(coalesce(p_error_message,'Generation failed.'),500) else null end,
      completed_at = now()
  where id = p_generation_id and user_id = p_user_id and status = 'reserved';
  return found;
end;
$$;
revoke all on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text) from public, anon, authenticated;
grant execute on function public.hookengine_finish_generation(uuid,uuid,text,text,text,text,text,jsonb,text[],text) to service_role;

-- Removes Instagram captions, Threads posts and Facebook posts from every plan.
-- These were Pro-only platforms; the extension is free for everyone now, so the
-- three platforms that remain are the only ones any plan can request.
-- Additive: existing generations keep their stored outputs.

update public.hookengine_plans
   set platform_keys = array['x_thread','linkedin_post','tiktok_hooks']::text[]
 where plan_key in ('free','trial','pro','lifetime');

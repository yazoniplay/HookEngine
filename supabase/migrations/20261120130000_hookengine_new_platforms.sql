-- Adds YouTube Shorts scripts, Reddit posts and Facebook posts to every plan.
-- Platform access is checked against hookengine_plans.platform_keys, so the
-- plan rows must list the new keys or the generation is refused.
update public.hookengine_plans
   set platform_keys = array['x_thread','linkedin_post','tiktok_hooks','youtube_shorts_script','reddit_post','facebook_post']::text[]
 where plan_key in ('free','trial','pro','lifetime');

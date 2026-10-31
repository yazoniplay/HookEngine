export const SUPABASE_URL = "https://ppaknwuwiublxogclqdw.supabase.co";
export const FUNCTION_URL = SUPABASE_URL + "/functions/v1/hookengine-generate";
export const STORAGE_KEYS = Object.freeze({
  session: "hookengine-account-session",
  theme: "hookengine-theme",
  writingPreferences: "hookengine-writing-preferences",
  lastGeneration: "hookengine-last-generation"
});
export const MAX_SOURCE_CHARS = 60000;
export const MIN_SOURCE_CHARS = 80;
export const VARIATION_SEPARATOR = "\n\n---HOOKENGINE-VARIATION---\n\n";
export const PLATFORM_LABELS = Object.freeze({
  x_thread: "X thread",
  linkedin_post: "LinkedIn post",
  tiktok_hooks: "TikTok hooks",
  instagram_caption: "Instagram caption",
  threads_posts: "Threads posts",
  facebook_post: "Facebook post"
});

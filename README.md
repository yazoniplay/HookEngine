# HookEngine

Chrome Manifest V3 side-panel extension that turns YouTube transcripts and article text into an X thread, LinkedIn post, and TikTok hooks using OpenAI GPT-4o.

## Project structure
- \`manifest.json\`, \`background.js\`, \`content.js\`: extension configuration and page extraction
- \`sidepanel.html\`, \`sidepanel.js\`, \`styles.css\`: responsive dark side-panel interface
- \`server/server.js\`: Express API proxy to OpenAI with optional Supabase JWT validation

## Run locally
1. Use Node.js 20+ on a computer you control.
2. In \`server/\`, copy \`.env.example\` to \`.env\` and set \`OPENAI_API_KEY\`.
3. Run \`npm install\` and \`npm start\` from the \`server/\` directory.
4. In Chrome, open \`chrome://extensions\`, enable Developer mode, click **Load unpacked**, and select the repository folder.
5. Click the extension icon. Open **API settings** and set the backend URL to \`http://localhost:3000\`.
6. Open an article or YouTube video, click **Read current tab**, then **Generate content**.

## YouTube transcript limitations
YouTube changes its DOM often. Open the video's own **Show transcript** panel before clicking **Read current tab**. The extension extracts captions already rendered in the page; it does not bypass access controls or fetch private captions. If the transcript is not exposed, it warns you.

## Deploy the backend
Deploy the \`server/\` directory as the service root on Railway or another Node host. Set \`OPENAI_API_KEY\` and \`ALLOWED_ORIGINS\` in environment variables. For production, allow the exact extension origin, \`chrome-extension://YOUR_EXTENSION_ID\`. Never include your OpenAI secret in extension files.

## Authentication and credits
Optional Supabase JWT verification is included in the API but disabled by default for local prototyping. Set \`AUTH_REQUIRED=true\` and configure \`SUPABASE_URL\` and \`SUPABASE_ANON_KEY\` before enabling it. A sign-in screen and credit accounting are **not implemented yet**, so this is an MVP foundation, not a production-ready paid SaaS. Add atomic credit deductions, rate limiting, and account management before exposing it publicly.

## Styling
The extension uses local CSS instead of loading Tailwind from a CDN. Manifest V3 extension pages restrict remotely hosted executable code, so a remote Tailwind runtime is not appropriate for production. The current UI uses charcoal, electric-blue accents, and responsive layouts.

## API
- \`GET /health\`
- \`POST /api/generate\` with \`{ "text": "...", "title": "...", "sourceUrl": "..." }\`
- Success: \`{ "x_thread": "...", "linkedin_post": "...", "tiktok_hooks": "..." }\`

Test against current Chrome and YouTube pages before relying on extraction in production.
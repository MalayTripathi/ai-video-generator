@AGENTS.md

# Reelcraft — AI Video Generator

Users describe a topic, get an AI-generated script, edit it conversationally,
then generate a voiceover, scene images, and a short video from it.

## Stack
- Claude API: script generation/editing; outputs structured scenes
- ElevenLabs API (`eleven_v3`): text-to-speech. v3 is required — the
  scripts carry inline audio tags (`[slowly]`, `[warmly]`) that older
  models would read aloud as words. Also covers Hindi.
- OpenAI Images API: per-scene image generation, individually regenerable
- fal.ai: image + video prompt → per-scene video, all scenes in parallel

## Conventions
- All external API calls happen server-side only (API routes / server
  actions), never in client components — these keys must never reach the browser.
- Design tokens come from the **Reelcraft canvas** in Claude Design (not the
  Nocturne design-system project directly — Reelcraft is the actual product
  token overlay; Nocturne is the foundation it's built on but isn't a token
  source itself), bound as `:root` / `.dark` CSS variables and mapped into
  the Tailwind theme. **Light is the default mode.** Use tokens, never
  hard-coded hex.
- Fonts: Inter (400/500/600) via `next/font/google`, exposed as
  `--font-inter` and consumed through `--font-body`/`--font-ui` — not the
  create-next-app default (Geist).
- Dark mode is class-based (`@custom-variant dark (&:where(.dark, .dark *))`
  in globals.css), not `prefers-color-scheme` — `.dark` is an explicit
  opt-in, matching "light is default."
- Tailwind gotcha: never name a custom `--spacing-*` theme key after a bare
  t-shirt size (sm/md/lg/xl/2xl/3xs/...). Tailwind v4 resolves
  max-w/w/h/min-w/max-h/min-h through `["--max-width", "--spacing",
  "--container"]` in that order, so a colliding `--spacing-sm` silently
  hijacks `max-w-sm` before Tailwind's real container scale is reached.
  Reelcraft's spacing scale is namespaced `--spacing-rc-*` (`gap-rc-sm`,
  `px-rc-lg`, ...) specifically to avoid this.
- Do not modify `src/proxy.ts` (Next.js 16's renamed `middleware.ts`) or
  `src/lib/supabase/*` unless the task is explicitly about session handling.
- Wizard state lives in the DB, not client state. Each step is a real URL
  (`/projects/[id]/script`, `/voiceover`, `/images`, `/video`) so work is
  resumable — generation is slow and costs money.
- Claude returns scripts as structured scenes (JSON), not prose. One scene
  = one image = one voiceover segment.
- Provider URLs expire (OpenAI, fal.ai). Always download artefacts and
  store them in the private `artifacts` Supabase Storage bucket; persist
  the storage path in the DB, never the provider URL. Serve via signed URLs.
- Long-running generations (fal.ai: 30–120s+) never block a request.
  Pattern: submit → store `external_id` in `jobs` → webhook updates the
  row → poll as fallback. Vercel functions can't stay open that long.
- Failures are per-scene, not per-project. A failed image or video retries
  that scene alone.
- Generation costs real money (~$0.07/sec of fal.ai video; a 96s project
  ≈ $6.70). When testing, use 2–3 scenes, not a full script.
- Model and provider config lives in `src/lib/config/models.ts`, read from
  env with defaults. Never hard-code a model name at a call site. Config
  sections are added when a step is built, not ahead of it.
- Anything the UI needs from a Claude call goes in the tool schema, not in
  free-text alongside it. Models frequently return tool_use with no text
  block.
- Playwright uses `channel: 'chrome'` (macOS 12 has no bundled chromium
  build). Don't run `npx playwright install chromium`. Integration tests
  mint a real throwaway Supabase user via `tests/supabase-test-session.ts`
  (`createTestSession`/`deleteTestUser`, admin-API magic-link session)
  rather than mocking auth — see `tests/dashboard-new-project.spec.ts`.

## Database
- `projects` — id, user_id, title, prompt, script, status, current_step,
  audio_path, total_duration_sec, timestamps. RLS on.
  `status` is unconstrained `text` (default `'draft'`, no DB enum/CHECK) —
  app-level convention is draft / in_progress / completed / failed. Keep
  any code writing this column consistent with those four.
  `current_step` is one of script / voiceover / images / video.
- `scenes` — id, project_id, position, scene_key ('s001'), voice_over
  (includes the inline `[tag]` cue), image_prompt, video_prompt,
  duration_sec (null until ElevenLabs reports it — Claude does NOT
  estimate duration), audio_path, image_path, video_path, image_status,
  video_status. Unique on (project_id, position).
  RLS via `exists` subquery on parent project ownership.
- `jobs` — id, project_id, scene_id, kind (audio|image|video), provider
  (elevenlabs|openai|fal), external_id, status, error, timestamps.
  RLS via the same `exists` pattern.
- Storage: private `artifacts` bucket.
- `messages` — id, project_id, role, content, timestamps. The script-step
  chat transcript. RLS via the same `exists` pattern.

## Done
- Supabase email/password auth: signup, login, sign-out, protected dashboard
- Root redirect: `/` → `/dashboard` or `/login`
- Auth screens styled to the design system, with inline validation
  (required fields, email format, password match, terms, min length)
- Deployed to Vercel
- Dashboard: left rail, top bar with user dropdown (real sign-out), status
  filter chips, project card grid reading live `projects` rows, empty
  state. "New project" (rail + empty state) is a real server action
  (`createProject`) that inserts a row and redirects into the wizard.
  Cards link to `/projects/[id]/{current_step}` — resumes wherever the
  project left off. Card thumbnails and the remaining nav items (Assets,
  Usage, Settings, search) are still visual-only pending real data/routes.
- Script step (`/projects/[id]/script`): dashboard shell reused (`Rail` +
  `TopBar`'s `left`/`right` slots), step indicator row (Script/Voiceover/
  Images/Video), inline-editable project title kept in sync between manual
  edits and Claude's auto-title update, 42/58 chat/scene-document split.
  Chat: message history, empty state, composer, busy/drafting indicator,
  posts to `/api/projects/[id]/script`. Scene document is **read-only**:
  scene rows (`Scene N` + voice-over text), empty/skeleton-loading states,
  a "just changed" highlight diffed after each turn, word count, and a
  "Continue to voiceover" link gated on scenes existing (target route
  doesn't exist yet). The API route itself drives a Claude `write_scenes`
  tool call, persists `scenes`/`messages`/a guarded `projects.title`
  update, and returns the applied title so the client stays in sync
  without a refetch.

## Current focus
TBD
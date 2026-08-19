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
- Schema changes go in `supabase/migrations/` via `supabase migration new`,
  applied with `db push` — never pasted into the dashboard SQL editor.
  Re-run `npm run types:db` after any change; `src/lib/database.types.ts`
  is generated, never hand-edited.
- Supabase clients are typed with the generated `Database` type. Don't
  infer schema from usage — read the types file.
- Prompt caching is wired on /script and /prompts but currently inert —
  static prompts (~400-450 tokens with tool schemas) sit under the
  minimum cacheable prefix (2048 Haiku / 1024 Sonnet). Don't pad prompts
  to reach it. It will activate on its own as prompts grow.
- Tailwind v4 gotcha: `<button>` has no default `cursor: pointer` in
  preflight (unlike v3). Every clickable button needs `cursor-pointer`
  added explicitly, plus `disabled:cursor-not-allowed` where the button
  toggles `disabled`.

## Database
Tables: `projects`, `scenes`, `messages`, `jobs`. All RLS-protected;
child tables via an `exists` subquery on project ownership.
Private `artifacts` Storage bucket.
Read `src/lib/database.types.ts` for columns — don't rely on this file.
Conventions not visible in the types: `projects.status` is unconstrained
text (draft / in_progress / completed / failed); `current_step` is
script / voiceover / images / video.

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
  posts to `/api/projects/[id]/script`. Chat failures render as a distinct
  `role: 'error'` message (icon + `status-failed-fg`, local-only — never
  persisted to `messages`), not a plain assistant bubble. Scene document:
  scene rows (`Scene N` + voice-over text), empty/skeleton-loading states,
  a "just changed" highlight diffed after each turn, word count, and a
  "Continue to voiceover" link gated on scenes existing. The API route
  itself drives a Claude `write_scenes` tool call, persists
  `scenes`/`messages`/a guarded `projects.title` update, and returns the
  applied title so the client stays in sync without a refetch.
- Scene voice-over text is inline-editable: click a scene row to edit,
  save on blur/Enter, Escape cancels (`SceneRow`, mirrors the title-edit
  pattern). Saved via `updateSceneVoiceOver` (`projects/[id]/actions.ts`)
  — a plain server action, no Claude call — which verifies project
  ownership and nulls `image_prompt`/`video_prompt` on change. Each row
  shows its own Saving…/Saved/Save failed+Retry indicator per the
  Reelcraft canvas's "Save indicator" spec; the old static "Saved" text
  in the TopBar was removed in favor of this per-row indicator.
- Two-phase scene generation: chat produces voice_over only; image_prompt
  and video_prompt generated on Continue via /api/projects/[id]/prompts.
  Prompts validated (min 50 chars, non-empty) before persistence — invalid
  entries stay null and are regenerable. Partial failure returns 422 and
  does not advance current_step.
- Prompt caching and history window on /script and /prompts.

## Current focus
@AGENTS.md

# Reelcraft — AI Video Generator

Users describe a topic, get an AI-generated script, edit it conversationally,
then generate a voiceover, scene images, and a short video from it.

## Stack
- Next.js 16 (App Router, TypeScript, `src/` dir) on Vercel
- Supabase: Postgres, auth, file storage
- Claude API: script generation/editing, voiceover segmenting
- ElevenLabs API: text-to-speech voiceover, with timestamps
- OpenAI Images API: scene image generation
- fal.ai: image-to-video generation

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

## Database
- `projects` — id, user_id, title, prompt, script, status, timestamps. RLS on.
  `status` is unconstrained `text` (default `'draft'`, no DB enum/CHECK) —
  app-level convention is draft / in_progress / completed / failed. Keep
  any code writing this column consistent with those four.
- `scenes` — id, project_id, position, text, visual_description, image_url.
  RLS via `exists` subquery on parent project ownership.

## Done
- Supabase email/password auth: signup, login, sign-out, protected dashboard
- Root redirect: `/` → `/dashboard` or `/login`
- Auth screens styled to the design system, with inline validation
  (required fields, email format, password match, terms, min length)
- Deployed to Vercel
- Dashboard: left rail, top bar with user dropdown (real sign-out), status
  filter chips, project card grid reading live `projects` rows, empty
  state. Card thumbnails, in-progress step detail, and several nav items
  (New project, Assets, Usage, Settings, search) are visual-only pending
  real data/routes.

## Current focus
TBD.
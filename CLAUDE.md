@AGENTS.md

# AI Video Generator

Users describe a topic, get an AI-generated script, edit it, then generate
a voiceover, scene images, and a short video from it.

## Stack
- Next.js (App Router, TypeScript) on Vercel
- Supabase: Postgres, auth, file storage
- Claude API: script generation/editing, voiceover segmenting
- ElevenLabs API: text-to-speech voiceover, with timestamps
- OpenAI Images API: scene image generation
- fal.ai: image-to-video generation

## Conventions
- All external API calls happen server-side only (API routes / server
  actions), never in client components — these keys must never reach the browser.
- Tables: `projects`, `script_versions`, `assets`

## Current focus
Setting up Supabase authentication first.
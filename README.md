This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The app deploys on the Hobby plan.

- **Fluid compute must be on** (`vercel.json` sets `"fluid": true`). Without it Hobby caps a
  function at 60s, and the image, voiceover, music and alignment routes need up to 300s.
- **Every route declares a literal `maxDuration` of at most 300** (Hobby's ceiling);
  `tests/route-max-duration.spec.ts` enforces it.
- **One region** (`vercel.json`: `sin1`), which Hobby allows.

Required environment variables (see `.env.example` for the full list and defaults):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`
- `IMAGES_INTERNAL_SECRET` - any long random string. A storyboard image batch larger than one
  150s run hands itself on to a fresh run with this secret; without it the unreached frames
  are released failed (retryable) and the run logs an error.

Never set an `ALLOW_REAL_*` variable on a deployment - production calls providers without
it. Set `BLOCK_PROVIDER_CALLS=1` to stop all provider spend on a deployment.

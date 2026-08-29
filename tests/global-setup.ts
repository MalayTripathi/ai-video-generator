export default function globalSetup() {
  if (process.env.ALLOW_REAL_CLAUDE === '1') {
    throw new Error(
      'ALLOW_REAL_CLAUDE=1 is set. This suite must never make a real, billed Anthropic call. ' +
        'Unset ALLOW_REAL_CLAUDE before running the Playwright suite. The only sanctioned way to ' +
        'make a live call is `npm run dev` with ALLOW_REAL_CLAUDE=1 exported by hand in your own ' +
        'shell, outside Playwright entirely.'
    )
  }
}

import { nextRuntime, validateAtBoot } from '@/lib/config/env'

// Runs once when a server instance starts, before it handles a request: validate the
// environment again (a Vercel function boots without next.config.ts) and log the resolved,
// non-secret config once. A failure here stops the server.
export function register() {
  if (nextRuntime() === 'nodejs') validateAtBoot('next')
}

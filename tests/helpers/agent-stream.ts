import type { Page } from '@playwright/test'

// A turn whose stream the TEST holds open. Playwright's route.fulfill can only deliver a
// whole body at once, so anything a turn does "while it runs" (a card locked, the composer
// disabled) would exist for the few hundred milliseconds between the panel's per-event
// yields, and a polling assertion would sometimes miss it. Replacing fetch for the agent
// route with a stream the test feeds keeps the turn running for exactly as long as the test
// wants: push events, assert on the running state, then settle.
//
// Call before page.goto (it installs an init script). Only the agent route itself
// (.../agent, not .../agent/turn-credits) is replaced.
export async function holdAgentTurnOpen(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __agentController?: ReadableStreamDefaultController<Uint8Array>
      __agentPush?: (event: Record<string, unknown>) => void
      __agentClose?: () => void
    }
    const realFetch = window.fetch.bind(window)
    const encoder = new TextEncoder()
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!/\/api\/projects\/[^/]+\/agent$/.test(url)) return realFetch(input, init)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          w.__agentController = controller
        },
      })
      w.__agentPush = (event) =>
        w.__agentController!.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      w.__agentClose = () => w.__agentController!.close()
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    }
  })
}

/** Resolves once the panel has sent its request (the held stream exists). */
export const agentRequestSent = (page: Page) =>
  page.waitForFunction(() => !!(window as unknown as { __agentPush?: unknown }).__agentPush)

export const pushAgentEvent = (page: Page, event: Record<string, unknown>) =>
  page.evaluate((e) => (window as unknown as { __agentPush: (x: unknown) => void }).__agentPush(e), event)

export const closeAgentStream = (page: Page) =>
  page.evaluate(() => (window as unknown as { __agentClose: () => void }).__agentClose())

/** Sends `settled` and ends the stream: the turn completes normally. */
export async function settleAgentTurn(page: Page, content = 'Done.') {
  await pushAgentEvent(page, { type: 'settled', content, cost: 0, messageId: 'held-turn' })
  await closeAgentStream(page)
}

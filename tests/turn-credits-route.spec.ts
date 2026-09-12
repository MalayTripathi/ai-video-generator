import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary, secondary } from './fixed-users'

// A real integration test for Credits Task 8's GET .../agent/turn-credits route - the
// agent-chat-panel.spec.ts tests exercise the client's consumption of it via a mocked
// route; this exercises the real handler: a real project, a real messages row (the
// FK credit_ledger.message_id points at), a real credit_ledger row, and RLS.
async function seedProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'turn-credits route test',
      source_text: 'Test project.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'workbench',
      video_model: 'mochi-1',
      furthest_step: 2,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function seedUserMessage(projectId: string) {
  const { data, error } = await admin
    .from('messages')
    .insert({ project_id: projectId, role: 'user', kind: 'text', content: 'do it' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

test.describe('GET /api/projects/[id]/agent/turn-credits', () => {
  test('returns the matching agent_turn spend row\'s credits, negated to a positive figure', async ({ page }) => {
    const projectId = await seedProject(primary.user.id)
    const messageId = await seedUserMessage(projectId)

    const { error: ledgerError } = await admin.from('credit_ledger').insert({
      user_id: primary.user.id,
      project_id: projectId,
      message_id: messageId,
      kind: 'spend',
      delta: -17,
      step: 'workbench',
      operation: 'agent_turn',
      attempt_id: crypto.randomUUID(),
      pricing_mode: 'dynamic',
      dedupe_key: `agent_turn:${crypto.randomUUID()}`,
      price_version: 'test',
    })
    expect(ledgerError).toBeNull()

    const response = await page.request.get(`/api/projects/${projectId}/agent/turn-credits?messageId=${messageId}`)
    expect(response.ok()).toBe(true)
    expect(await response.json()).toEqual({ credits: 17 })
  })

  test('returns credits: null for a message with no matching spend row - never 0', async ({ page }) => {
    const projectId = await seedProject(primary.user.id)
    const messageId = await seedUserMessage(projectId)

    const response = await page.request.get(`/api/projects/${projectId}/agent/turn-credits?messageId=${messageId}`)
    expect(response.ok()).toBe(true)
    expect(await response.json()).toEqual({ credits: null })
  })

  test('a user cannot read another user\'s turn credits - 404, not their data', async ({ page }) => {
    // Default storageState (per playwright.config.ts) is primary - requesting a
    // project owned by secondary must 404 at the ownership check, before the
    // credit_ledger query (and its own RLS) is even reached.
    const projectId = await seedProject(secondary.user.id)
    const messageId = await seedUserMessage(projectId)
    await admin.from('credit_ledger').insert({
      user_id: secondary.user.id,
      project_id: projectId,
      message_id: messageId,
      kind: 'spend',
      delta: -9,
      step: 'workbench',
      operation: 'agent_turn',
      attempt_id: crypto.randomUUID(),
      pricing_mode: 'dynamic',
      dedupe_key: `agent_turn:${crypto.randomUUID()}`,
      price_version: 'test',
    })

    const response = await page.request.get(`/api/projects/${projectId}/agent/turn-credits?messageId=${messageId}`)
    expect(response.status()).toBe(404)
  })
})

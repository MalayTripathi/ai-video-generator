import { test, expect } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { insertUserMessage } from '../src/lib/messages-idempotency'

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({ user_id: userId, title: 'Untitled project', current_step: 'workbench' })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

test.describe('insertUserMessage', () => {
  test('a fresh client_id inserts the message', async () => {
    const projectId = await insertProject(primary.user.id)
    const clientId = crypto.randomUUID()

    const result = await insertUserMessage({
      supabase: admin,
      projectId,
      content: 'hello',
      clientId,
    })

    expect(result.outcome).toBe('inserted')
    expect(result.outcome === 'inserted' && result.message.content).toBe('hello')
    expect(result.outcome === 'inserted' && result.message.client_id).toBe(clientId)
  })

  test('a repeated (project_id, client_id) is detected as a duplicate and returns the original row untouched', async () => {
    const projectId = await insertProject(primary.user.id)
    const clientId = crypto.randomUUID()

    const first = await insertUserMessage({ supabase: admin, projectId, content: 'first attempt', clientId })
    expect(first.outcome).toBe('inserted')

    const second = await insertUserMessage({ supabase: admin, projectId, content: 'resent after a lost response', clientId })

    expect(second.outcome).toBe('duplicate')
    expect(second.outcome === 'duplicate' && second.message.content).toBe('first attempt')
    expect(second.outcome === 'duplicate' && second.message.id).toBe(
      first.outcome === 'inserted' ? first.message.id : undefined
    )
  })

  test('the same client_id under a different project succeeds independently', async () => {
    const projectA = await insertProject(primary.user.id)
    const projectB = await insertProject(primary.user.id)
    const clientId = crypto.randomUUID()

    const resultA = await insertUserMessage({ supabase: admin, projectId: projectA, content: 'in A', clientId })
    const resultB = await insertUserMessage({ supabase: admin, projectId: projectB, content: 'in B', clientId })

    expect(resultA.outcome).toBe('inserted')
    expect(resultB.outcome).toBe('inserted')
  })

  test('two messages with no client_id both insert - NULL is never treated as a duplicate', async () => {
    const projectId = await insertProject(primary.user.id)

    const first = await admin.from('messages').insert({ project_id: projectId, role: 'user', content: 'one' })
    const second = await admin.from('messages').insert({ project_id: projectId, role: 'user', content: 'two' })

    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
  })

  test('a duplicate client_id still resolves to the original user row once an assistant reply shares that client_id', async () => {
    const projectId = await insertProject(primary.user.id)
    const clientId = crypto.randomUUID()

    const first = await insertUserMessage({ supabase: admin, projectId, content: 'first attempt', clientId })
    expect(first.outcome).toBe('inserted')

    // A completed turn persists its reply carrying the SAME client_id as its triggering
    // user message (see migration scope_messages_client_id_to_user_role - only
    // role='user' rows are constrained unique on it, so this insert must succeed).
    const { error: assistantError } = await admin
      .from('messages')
      .insert({ project_id: projectId, role: 'assistant', content: 'the reply', client_id: clientId })
    expect(assistantError).toBeNull()

    const second = await insertUserMessage({
      supabase: admin,
      projectId,
      content: 'resent after a lost response',
      clientId,
    })

    expect(second.outcome).toBe('duplicate')
    expect(second.outcome === 'duplicate' && second.message.role).toBe('user')
    expect(second.outcome === 'duplicate' && second.message.content).toBe('first attempt')
  })
})

import { test, expect, type Page, type Locator } from '@playwright/test'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import { holdAgentTurnOpen, agentRequestSent, pushAgentEvent as push, closeAgentStream as close, settleAgentTurn as settle } from './helpers/agent-stream'

// While the Step 3 agent is regenerating a prompt, that card must behave exactly like a
// card the Regenerate button is rewriting: the editor gives way to the writing state (so a
// hand edit cannot race the agent's write and be silently overwritten), and Regenerate is
// unavailable. Untouched cards stay editable. Everything unlocks when the turn settles.

const PROMPT = (n: number) =>
  `Prompt ${n}: a wide establishing shot of the harbour at dawn, soft light on the water, mist, documentary framing.`

async function seed(count = 2) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Step 3 agent lock',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: 3,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  for (const [step, operation] of [
    ['workbench', 'generate_shots'],
    ['image_prompts', 'write_image_prompts'],
  ] as const) {
    await admin.from('generations').insert({ project_id: projectId, step, operation, shot_id: null, state: 'succeeded' })
  }
  const { error: shotsError } = await admin.from('shots').insert(
    Array.from({ length: count }, (_, i) => ({
      project_id: projectId,
      order_index: i,
      shot_key: `lk${i}${Math.random().toString(36).slice(2, 4)}`,
      voice_over: `Voice over ${i}`,
      image_prompt: PROMPT(i + 1),
      image_prompt_stale: false,
    }))
  )
  expect(shotsError).toBeNull()
  return projectId
}

const card = (page: Page, n: number): Locator =>
  page.locator('div[aria-busy]').filter({ has: page.getByText(`Shot ${n}`, { exact: true }) })

async function send(page: Page, content: string) {
  await page.getByLabel('Ask for a change').fill(content)
  await page.getByRole('button', { name: 'Send' }).click()
  await agentRequestSent(page)
}

test.describe('Step 3 agent - card locking', () => {
  test('a single-shot regeneration locks only that card while the turn runs, then unlocks', async ({ page }) => {
    const projectId = await seed()
    await holdAgentTurnOpen(page)
    await page.goto(`/projects/${projectId}/image_prompts`)
    await send(page, 'make shot 1 colder')

    await push(page, { type: 'turn_started' })
    await push(page, { type: 'tool_started', scope: { shotNumber: 1 } })

    // The turn is still running (nothing has settled), so the lock is held indefinitely.
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'true')
    await expect(card(page, 1).getByLabel('Image prompt')).toHaveCount(0)
    await expect(card(page, 2)).toHaveAttribute('aria-busy', 'false')
    await expect(card(page, 2).getByLabel('Image prompt')).toBeEditable()
    // No Regenerate is available while a prompt is being written.
    await expect(page.getByRole('button', { name: /Regenerate/ }).first()).toBeDisabled()

    await push(page, { type: 'tool_completed', label: 'x', toolName: 'regenerate_image_prompt', shotKey: 'unused' })
    // Completion alone does not release it: the new text only arrives at settle.
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'true')

    await settle(page)
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'false')
    await expect(card(page, 1).getByLabel('Image prompt')).toBeEditable()
  })

  test('regenerate-all locks every card while the turn runs, then unlocks', async ({ page }) => {
    const projectId = await seed()
    await holdAgentTurnOpen(page)
    await page.goto(`/projects/${projectId}/image_prompts`)
    await send(page, 'redo everything')

    await push(page, { type: 'tool_started', scope: 'all' })
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'true')
    await expect(card(page, 2)).toHaveAttribute('aria-busy', 'true')

    await settle(page)
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'false')
    await expect(card(page, 2)).toHaveAttribute('aria-busy', 'false')
  })

  test('a dropped stream still releases every lock', async ({ page }) => {
    const projectId = await seed()
    await holdAgentTurnOpen(page)
    await page.goto(`/projects/${projectId}/image_prompts`)
    await send(page, 'redo everything')

    await push(page, { type: 'tool_started', scope: 'all' })
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'true')

    // The connection ends with no `settled` ever sent.
    await close(page)
    await expect(card(page, 1)).toHaveAttribute('aria-busy', 'false')
    await expect(card(page, 2)).toHaveAttribute('aria-busy', 'false')
  })
})

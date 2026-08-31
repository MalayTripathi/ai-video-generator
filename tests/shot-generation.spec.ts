import { test, expect } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { runShotGeneration } from '../src/app/api/projects/[id]/shots/logic'
import { successMessage, truncatedMessage, throwingGateway } from './helpers/claude-fakes'
import type { ClaudeGateway } from '../src/lib/claude'

const SHOT_KEY_RE = /^[23456789bcdfghjkmnpqrstvwxz]{5}$/

const RICH_INPUT = {
  title: 'The Lighthouse Keeper',
  message: 'Here is your shot list.',
  video_type: 'narrated_story',
  shots: [
    {
      voice_over: 'Mara had kept the light for twenty years.',
      visual_description: 'Wide shot of a lighthouse at dusk.',
      shot_size: 'wide',
      camera_angle: 'eye_level',
      camera_movement: 'static',
      duration_sec: 5,
      section_label: 'Intro',
      dialogue: [],
      element_names: [{ name: 'Mara', type: 'character', description: 'A lighthouse keeper' }],
    },
    {
      voice_over: 'One stormy night, she heard a voice on the wind.',
      visual_description: 'Close up of Mara listening at the window.',
      shot_size: 'close_up',
      camera_angle: 'eye_level',
      camera_movement: 'slow_push_in',
      duration_sec: 4,
      section_label: 'Intro',
      // Same name as above, different casing - proves case-insensitive dedup.
      dialogue: [{ speaker_name: 'mara', line: 'Is anyone out there?' }],
      element_names: [],
    },
    {
      voice_over: 'Her dog was the first to reach the shore.',
      visual_description: 'Medium shot of a dog running along the rocks.',
      shot_size: 'medium',
      camera_angle: 'low',
      camera_movement: 'pan',
      duration_sec: 4,
      section_label: 'Rescue',
      dialogue: [],
      // A second, genuinely distinct element - proves non-dedup across different names.
      element_names: [{ name: 'Old Dog', type: 'character', description: 'Her loyal companion' }],
    },
  ],
}

async function insertProject(userId: string) {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: null,
      source_text: 'A short film about a lighthouse keeper and her dog.',
      video_type: 'auto',
      duration_target: '1-2min',
      current_step: 'workbench',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

async function readGeneration(projectId: string) {
  const { data, error } = await admin
    .from('generations')
    .select('state, payload')
    .eq('project_id', projectId)
    .eq('step', 'workbench')
    .eq('operation', 'generate_shots')
    .is('shot_id', null)
    .single()
  expect(error).toBeNull()
  return data!
}

test.describe('Step 2 workbench - shot generation', () => {
  test('parses shots, applies the title/video_type, inserts an assistant message, and lands on ready with the payload cleared', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id)
      const gateway: ClaudeGateway = { async createMessage() { return successMessage(RICH_INPUT) } }

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })
      expect(result.ok).toBe(true)

      const { data: shots, error: shotsError } = await admin
        .from('shots')
        .select('shot_key')
        .eq('project_id', projectId)
      expect(shotsError).toBeNull()
      expect(shots!.length).toBe(RICH_INPUT.shots.length)

      const keys = shots!.map((s) => s.shot_key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) expect(key).toMatch(SHOT_KEY_RE)

      const { data: project, error: projectError } = await admin
        .from('projects')
        .select('title, video_type')
        .eq('id', projectId)
        .single()
      expect(projectError).toBeNull()
      expect(project!.title).toBe(RICH_INPUT.title)
      expect(project!.video_type).toBe(RICH_INPUT.video_type)

      const generation = await readGeneration(projectId)
      expect(generation.state).toBe('succeeded')
      expect(generation.payload).toBeNull()

      const { data: messages, error: messagesError } = await admin
        .from('messages')
        .select('role, content')
        .eq('project_id', projectId)
        .eq('role', 'assistant')
      expect(messagesError).toBeNull()
      expect(messages!.length).toBeGreaterThan(0)
      expect(messages![0].content.trim().length).toBeGreaterThan(0)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('dedupes an element referenced by name in one shot and by dialogue speaker in another, and resolves dialogue to the deduped element', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id)
      const gateway: ClaudeGateway = { async createMessage() { return successMessage(RICH_INPUT) } }

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })
      expect(result.ok).toBe(true)

      const { data: elements, error: elementsError } = await admin
        .from('elements')
        .select('id, name')
        .eq('project_id', projectId)
      expect(elementsError).toBeNull()
      // Exactly 2 unique names (Mara, Old Dog) - not 3, which would mean the dialogue
      // speaker "mara" created a second row instead of matching the element_names one.
      expect(elements!.length).toBe(2)
      const lowerNames = elements!.map((e) => e.name.toLowerCase())
      expect(new Set(lowerNames).size).toBe(lowerNames.length)

      const mara = elements!.find((e) => e.name.toLowerCase() === 'mara')
      expect(mara).toBeTruthy()

      const { data: shotsWithDialogue, error: shotsError } = await admin
        .from('shots')
        .select('order_index, dialogue')
        .eq('project_id', projectId)
        .order('order_index', { ascending: true })
      expect(shotsError).toBeNull()

      const dialogueShot = shotsWithDialogue!.find((s) => s.order_index === 1)
      expect(dialogueShot).toBeTruthy()
      const dialogue = dialogueShot!.dialogue as { element_id: string; line: string }[]
      expect(dialogue.length).toBe(1)
      expect(dialogue[0].element_id).toBe(mara!.id)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a gateway call that throws still leaves a usage row, failed, with a non-null estimated cost', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id)
      const gateway = throwingGateway('simulated network failure')

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })
      expect(result.ok).toBe(false)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, estimated_cost, step, operation')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('failed')
      expect(usageRows![0].estimated_cost).not.toBeNull()
      expect(usageRows![0].step).toBe('workbench')
      expect(usageRows![0].operation).toBe('generate_shots')
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a successful call writes exactly one succeeded usage row with a measured cost below the quote', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id)
      const gateway: ClaudeGateway = { async createMessage() { return successMessage(RICH_INPUT) } }

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })
      expect(result.ok).toBe(true)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, estimated_cost, quantity, raw_usage')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('succeeded')
      expect(usageRows![0].quantity).toBe(20) // successMessage's fixed 10 input + 10 output tokens
      const raw = usageRows![0].raw_usage as { quoted?: unknown }
      // The measured cost (tiny, fixed 20-token usage) must be far below the worst-case
      // quote (max_tokens at the output rate) that raw_usage.quoted would have recorded
      // had settle never overwritten it.
      expect(raw.quoted).toBeUndefined()
      expect(usageRows![0].estimated_cost).toBeGreaterThan(0)
      expect(usageRows![0].estimated_cost).toBeLessThan(0.001)
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a max_tokens truncation writes a failed usage row with stop_reason max_tokens and a measured cost', async () => {
    const { user } = await createTestSession()
    try {
      const projectId = await insertProject(user.id)
      const gateway: ClaudeGateway = { async createMessage() { return truncatedMessage(RICH_INPUT) } }

      const result = await runShotGeneration({ gateway, supabase: admin, projectId, userId: user.id, retry: false })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(422)

      const { data: usageRows, error: usageError } = await admin
        .from('usage')
        .select('status, stop_reason, estimated_cost')
        .eq('project_id', projectId)
      expect(usageError).toBeNull()
      expect(usageRows!.length).toBe(1)
      expect(usageRows![0].status).toBe('failed')
      expect(usageRows![0].stop_reason).toBe('max_tokens')
      expect(usageRows![0].estimated_cost).not.toBeNull()
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

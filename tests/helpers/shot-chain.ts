import type Anthropic from '@anthropic-ai/sdk'
import type { ClaudeGateway } from '../../src/lib/claude'
import { admin } from '../supabase-test-session'
import { runShotsRequest, type ShotsRequestMode, type ShotsRequestResult } from '../../src/app/api/projects/[id]/shots/logic'
import { runShotsWorker, type ShotsContinuationPayload, type ShotsWorkerResult } from '../../src/app/api/projects/[id]/shots/worker'
import type { ShotRunLedger } from '../../src/lib/shots/runs'
import { successMessage } from './claude-fakes'

// The shot-generation chain run in-process against fakes: the request phase, then every
// run of the chain, each continuation queued and run after the one that handed it on (as a
// fresh invocation would be). No provider call ever leaves the process.

export type FakeShot = {
  voice_over: string
  visual_description: string
  shot_size: string
  camera_angle: string
  camera_movement: string
  shot_size_origin: string
  camera_angle_origin: string
  camera_movement_origin: string
  duration_sec: number
  dialogue: { speaker_name: string; line: string }[]
  element_names: { name: string; type: string; description: string }[]
}

export function fakeShot(voiceOver: string, extra: Partial<FakeShot> = {}): FakeShot {
  return {
    voice_over: voiceOver,
    visual_description: `Visual for: ${voiceOver || 'a silent moment'}`,
    shot_size: 'wide',
    camera_angle: 'eye_level',
    camera_movement: 'static',
    shot_size_origin: 'auto',
    camera_angle_origin: 'auto',
    camera_movement_origin: 'auto',
    duration_sec: 3,
    dialogue: [],
    element_names: [],
    ...extra,
  }
}

export type FakeOutlineScene = { title: string; seconds: number; element_names?: string[] }

export function fakeOutline(scenes: FakeOutlineScene[], extra: Record<string, unknown> = {}) {
  return {
    title: 'Chain test',
    message: 'Planned.',
    video_type: 'explainer',
    style: [],
    scenes: scenes.map((s) => ({
      title: s.title,
      summary: `About ${s.title}.`,
      location: 'Somewhere',
      time_of_day: 'day',
      element_names: s.element_names ?? [],
      seconds: s.seconds,
    })),
    ...extra,
  }
}

/** What a chunk request asked for, parsed from its user message. */
export type ChunkAsk = { scenePosition: number; maxShots: number; previous: string | null }

export function parseChunkAsk(params: Anthropic.MessageCreateParams): ChunkAsk {
  const text = String((params.messages[0] as { content: string }).content)
  const scene = Number(/^Scene (\d+):/m.exec(text)?.[1] ?? '0') - 1
  const maxShots = Number(/Write at most (\d+) shots/.exec(text)?.[1] ?? '0')
  const previous = /Narration: (.*)$/m.exec(text)?.[1] ?? null
  return { scenePosition: scene, maxShots, previous }
}

export type ChainCall = { tool: string; at: number; ask: ChunkAsk | null }

/**
 * A gateway answering the outline with `outline` and every chunk with `chunk(ask, n)` - n
 * counting that scene's chunks from 0, each chunk after `delayMs`. Records each call.
 */
export function chainGateway(params: {
  outline: unknown
  chunk: (ask: ChunkAsk, chunkOfScene: number) => { shots: FakeShot[]; scene_complete: boolean }
  delayMs?: number
  usage?: { input_tokens: number; output_tokens: number }
}): ClaudeGateway & { calls: ChainCall[] } {
  const calls: ChainCall[] = []
  const perScene = new Map<number, number>()
  return {
    calls,
    async createMessage(p) {
      const tool = (p.tool_choice as { name?: string } | undefined)?.name ?? ''
      const at = Date.now()
      if (tool === 'write_outline') {
        calls.push({ tool, at, ask: null })
        return successMessage(params.outline, 'write_outline', params.usage)
      }
      const ask = parseChunkAsk(p)
      calls.push({ tool, at, ask })
      if (params.delayMs) await new Promise((r) => setTimeout(r, params.delayMs))
      const n = perScene.get(ask.scenePosition) ?? 0
      perScene.set(ask.scenePosition, n + 1)
      return successMessage(params.chunk(ask, n), 'write_shots', params.usage)
    },
  }
}

export const NO_LEDGER: ShotRunLedger = {
  recordFixedSpend: async () => {},
  recordDynamicSpend: async () => {},
}

export type ChainRun = { startedAt: number; result: ShotsWorkerResult }

/**
 * Runs the request and, if it was accepted, the whole chain. `continueRun` can be
 * replaced to simulate a refused or lost hand-off (return false, or true without running).
 */
export async function runChain(params: {
  projectId: string
  userId: string
  gateway: ClaudeGateway
  mode?: ShotsRequestMode
  retry?: boolean
  attemptId?: string
  messageId?: string | null
  agentGenerationId?: string | null
  ledger?: ShotRunLedger
  balance?: number | (() => number)
  runBudgetMs?: number
  chainLimit?: number
  concurrency?: number
  /** Return false to refuse a hand-off; 'drop' accepts it but never runs it (a dead chain). */
  handOff?: (payload: ShotsContinuationPayload) => boolean | 'drop'
}): Promise<{ request: ShotsRequestResult; runs: ChainRun[] }> {
  const ledger = params.ledger ?? NO_LEDGER
  const balance = () => (typeof params.balance === 'function' ? params.balance() : (params.balance ?? 1_000_000))
  const request = await runShotsRequest({
    supabase: admin,
    projectId: params.projectId,
    userId: params.userId,
    mode: params.mode ?? 'generate',
    retry: params.retry ?? false,
    attemptId: params.attemptId ?? crypto.randomUUID(),
    messageId: params.messageId ?? null,
    agentGenerationId: params.agentGenerationId ?? null,
    getBalance: async () => balance(),
    ensureSignupGrant: async () => {},
    ledger,
  })
  if (!request.ok) return { request, runs: [] }
  const runs = await runChainFrom(params, { userId: params.userId, projectId: params.projectId, runId: request.runId, chainDepth: 0 })
  return { request, runs }
}

/** Runs the chain from one run's payload onward. */
export async function runChainFrom(
  params: Parameters<typeof runChain>[0],
  first: ShotsContinuationPayload | (Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 })
): Promise<ChainRun[]> {
  const ledger = params.ledger ?? NO_LEDGER
  const balance = () => (typeof params.balance === 'function' ? params.balance() : (params.balance ?? 1_000_000))
  const queue: (ShotsContinuationPayload | (Omit<ShotsContinuationPayload, 'chainDepth'> & { chainDepth: 0 }))[] = [first]
  const runs: ChainRun[] = []
  while (queue.length > 0) {
    const payload = queue.shift()!
    const startedAt = Date.now()
    const result = await runShotsWorker(
      {
        supabase: admin,
        gateway: params.gateway,
        ledger,
        readBalance: async () => balance(),
        continueRun: async (next) => {
          const decision = params.handOff ? params.handOff(next) : true
          if (decision === true) queue.push(next)
          return decision !== false
        },
        runBudgetMs: params.runBudgetMs,
        chainLimit: params.chainLimit,
        concurrency: params.concurrency,
      },
      payload
    )
    runs.push({ startedAt, result })
  }
  return runs
}

export async function insertChainProject(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: null,
      source_text: 'A short explainer about lighthouses.',
      video_type: 'auto',
      duration_target: '1-2min',
      video_model: 'wan-3.0',
      language: 'en',
      current_step: 'workbench',
      furthest_step: 2,
      ...overrides,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return data.id
}

export async function readChainShots(projectId: string) {
  const { data, error } = await admin
    .from('shots')
    .select('id, order_index, voice_over, duration_sec, narration_overflow, scene_id, scenes(position, title)')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as {
    id: string
    order_index: number
    voice_over: string
    duration_sec: number | null
    narration_overflow: boolean
    scene_id: string | null
    scenes: { position: number; title: string } | null
  }[]
}

export async function readRun(runId: string) {
  const { data, error } = await admin
    .from('shot_runs')
    .select('*, shot_run_chunks(*)')
    .eq('id', runId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

import { IMAGE_QUALITIES, type ImageQuality } from './enums'
import { isPricedClaudeModel } from './claude-rates'

// The environment: with env.server.ts, the only modules that read process.env (CLAUDE.md
// hard rule 19; tests/env-source-guard.spec.ts enforces it). Every var is declared here with
// its class, and parseEnv is the one validator - boot (next.config.ts, instrumentation.ts,
// the export worker) and every server accessor run it, so a value the boot check accepted is
// the value the code uses.
//
// This module is client-safe: the browser bundle gets the two NEXT_PUBLIC_* values (each read
// by its literal name, which is what Next inlines) and APP_ENV (inlined by next.config.ts's
// `env`). Server-only values are read through env.server.ts.

export const APP_ENVS = ['local', 'preview', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

/**
 * A  required everywhere - boot throws.
 * B  required on preview/production; on local an unset var takes its dev value, with a boot warning.
 * C  IMAGE_QUALITY_DEV_CAP - required on local/preview, refused on production.
 * D  optional tuning - unset takes the code default silently; a malformed value throws.
 * E  ALLOW_REAL_* - developer-only live-call opt-ins (live-call-guard.ts).
 * F  PW_* - test runner; set by npm scripts, the run guard or per command, never in .env.local.
 */
export type EnvClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

const CLAUDE_DEV_MODEL = 'claude-haiku-5-5'

// Class B dev values, used only on local when the var is unset.
const LOCAL_FALLBACK = {
  CLAUDE_SHOTS_MODEL: CLAUDE_DEV_MODEL,
  CLAUDE_SHOT_OUTLINE_MAX_TOKENS: '8000',
  CLAUDE_SHOTS_MAX_TOKENS: '8000',
  CLAUDE_CAMERA_MODEL: CLAUDE_DEV_MODEL,
  CLAUDE_CAMERA_MAX_TOKENS: '500',
  CLAUDE_AGENT_MODEL: CLAUDE_DEV_MODEL,
  CLAUDE_AGENT_MAX_TOKENS: '8192',
  CLAUDE_IMAGE_PROMPTS_MODEL: CLAUDE_DEV_MODEL,
  CLAUDE_IMAGE_PROMPTS_MAX_TOKENS: '8192',
  CLAUDE_MUSIC_PROMPT_MODEL: CLAUDE_DEV_MODEL,
  CLAUDE_MUSIC_PROMPT_MAX_TOKENS: '500',
  VOICEOVER_PROVIDER: 'elevenlabs',
  ELEVENLABS_VOICEOVER_MODEL: 'eleven_v3',
  MUSIC_PROVIDER: 'elevenlabs',
  ELEVENLABS_MUSIC_MODEL: 'music_v1',
} as const
type ClassBVar = keyof typeof LOCAL_FALLBACK

// Class D code defaults.
const TUNING_DEFAULT = {
  EXPORT_CRF: 20,
  EXPORT_FPS: 30,
  EXPORT_MOTION_UPSCALE: 4,
  EXPORT_POLL_MS: 4000,
  EXPORT_STUCK_TIMEOUT_MS: 20 * 60_000,
  EXPORT_DEV_MAX_SHOTS: 2,
  EXPORT_DEV_MAX_SEC: 15,
} as const

export const ENV_VARS: Record<string, EnvClass> = {
  APP_ENV: 'A',
  NEXT_PUBLIC_SUPABASE_URL: 'A',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'A',
  SUPABASE_SERVICE_ROLE_KEY: 'A',
  ANTHROPIC_API_KEY: 'A',
  OPENAI_API_KEY: 'A',
  ELEVENLABS_API_KEY: 'A',
  INTERNAL_CONTINUATION_SECRET: 'A',
  SPEND_CAP_ENABLED: 'A',
  SPEND_CAP_MONTHLY_USD: 'A',
  ...(Object.fromEntries(Object.keys(LOCAL_FALLBACK).map((k) => [k, 'B'])) as Record<ClassBVar, 'B'>),
  IMAGE_QUALITY_DEV_CAP: 'C',
  ...(Object.fromEntries(Object.keys(TUNING_DEFAULT).map((k) => [k, 'D'])) as Record<keyof typeof TUNING_DEFAULT, 'D'>),
  BLOCK_PROVIDER_CALLS: 'D',
  FFMPEG_PATH: 'D',
  ALLOW_REAL_CLAUDE: 'E',
  ALLOW_REAL_OPENAI_IMAGES: 'E',
  ALLOW_REAL_ELEVENLABS: 'E',
  PW_SERVER: 'F',
  PW_UI_WORKERS: 'F',
  PW_API_WORKERS: 'F',
  PW_FULL_RUN_MODULE: 'F',
  PW_FULL_RUN_OVERRIDE: 'F',
  PW_RUN_GUARD_DRY_RUN: 'F',
  PW_FULL_RUN_SCRIPT: 'F',
  PW_RUN_GUARD_CHILD: 'F',
}

export const SUPPORTED_ELEVENLABS = {
  provider: ['elevenlabs'],
  voiceoverModel: ['eleven_v3'],
  musicModel: ['music_v1'],
} as const

const CAP_MIN = 100
const CAP_MAX = 64_000
const SECRET_MIN_LENGTH = 32

export class EnvError extends Error {
  readonly varName: string
  constructor(varName: string, reason: string) {
    super(`[env] ${varName} ${reason}`)
    this.name = 'EnvError'
    this.varName = varName
  }
}

export type EnvSource = Record<string, string | undefined>

export type ClaudeEnv = {
  shotsModel: string
  shotOutlineMaxTokens: number
  shotsMaxTokens: number
  cameraModel: string
  cameraMaxTokens: number
  agentModel: string
  agentMaxTokens: number
  imagePromptsModel: string
  imagePromptsMaxTokens: number
  musicPromptModel: string
  musicPromptMaxTokens: number
}

export type TuningEnv = {
  exportCrf: number
  exportFps: number
  exportMotionUpscale: number
  exportPollMs: number
  exportStuckTimeoutMs: number
  exportDevMaxShots: number
  exportDevMaxSec: number
  blockProviderCalls: boolean
  ffmpegPath: string | null
}

type SupabaseEnv = { url: string; anonKey: string; serviceRoleKey: string }
type SpendCapEnv = { enabled: boolean; monthlyUsd: number }

export type NextEnv = {
  appEnv: AppEnv
  supabase: SupabaseEnv
  providerKeys: { anthropic: string; openai: string; elevenlabs: string }
  continuationSecret: string
  spendCap: SpendCapEnv
  claude: ClaudeEnv
  elevenlabs: { voiceoverProvider: 'elevenlabs'; voiceoverModel: string; musicProvider: 'elevenlabs'; musicModel: string }
  imageQualityDevCap: ImageQuality | null
  tuning: TuningEnv
}

// The export worker reads no provider key and no continuation secret, so it requires neither.
export type WorkerEnv = {
  appEnv: AppEnv
  supabase: Omit<SupabaseEnv, 'anonKey'>
  spendCap: SpendCapEnv
  tuning: TuningEnv
}

export type EnvScope = 'next' | 'worker'
export type ParsedEnv<S extends EnvScope> = { env: S extends 'next' ? NextEnv : WorkerEnv; warnings: string[] }

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== ''

function required(source: EnvSource, name: string): string {
  const value = source[name]
  if (!present(value)) throw new EnvError(name, 'is required and is not set')
  return value.trim()
}

/** APP_ENV, checked against VERCEL_ENV when the platform sets one. */
export function parseAppEnv(source: EnvSource): AppEnv {
  const value = required(source, 'APP_ENV')
  if (!(APP_ENVS as readonly string[]).includes(value)) {
    throw new EnvError('APP_ENV', `must be one of ${APP_ENVS.join(' | ')}, got "${value}"`)
  }
  const vercel = source.VERCEL_ENV
  // Vercel's own name for a local `vercel dev` is "development".
  if (present(vercel) && (vercel === 'development' ? 'local' : vercel) !== value) {
    throw new EnvError('APP_ENV', `is "${value}" but VERCEL_ENV is "${vercel}" - they must match`)
  }
  return value as AppEnv
}

function int(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new EnvError(name, `must be an integer from ${min} to ${max}, got "${raw}"`)
  }
  return n
}

function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new EnvError(name, `must be one of ${allowed.join(' | ')}, got "${raw}"`)
  }
  return raw as T
}

function parseSupabase(source: EnvSource) {
  return {
    url: required(source, 'NEXT_PUBLIC_SUPABASE_URL'),
    serviceRoleKey: required(source, 'SUPABASE_SERVICE_ROLE_KEY'),
  }
}

function parseSpendCap(source: EnvSource): SpendCapEnv {
  const enabled = oneOf('SPEND_CAP_ENABLED', required(source, 'SPEND_CAP_ENABLED'), ['0', '1'])
  const rawUsd = required(source, 'SPEND_CAP_MONTHLY_USD')
  const monthlyUsd = Number(rawUsd)
  if (!/^\d+(\.\d+)?$/.test(rawUsd) || !(monthlyUsd > 0)) {
    throw new EnvError('SPEND_CAP_MONTHLY_USD', `must be a positive number, got "${rawUsd}"`)
  }
  return { enabled: enabled === '1', monthlyUsd }
}

/** Class D: unset (or empty) takes the code default silently; anything set must be valid. */
export function parseTuning(source: EnvSource): TuningEnv {
  const tune = (name: keyof typeof TUNING_DEFAULT, min: number, max: number) => {
    const raw = source[name]
    return present(raw) ? int(name, raw.trim(), min, max) : TUNING_DEFAULT[name]
  }
  const block = source.BLOCK_PROVIDER_CALLS
  const ffmpeg = source.FFMPEG_PATH
  return {
    exportCrf: tune('EXPORT_CRF', 0, 51),
    exportFps: tune('EXPORT_FPS', 1, 120),
    exportMotionUpscale: tune('EXPORT_MOTION_UPSCALE', 1, 8),
    exportPollMs: tune('EXPORT_POLL_MS', 100, 600_000),
    exportStuckTimeoutMs: tune('EXPORT_STUCK_TIMEOUT_MS', 1000, 24 * 3_600_000),
    exportDevMaxShots: tune('EXPORT_DEV_MAX_SHOTS', 1, 1000),
    exportDevMaxSec: tune('EXPORT_DEV_MAX_SEC', 1, 3600),
    blockProviderCalls: present(block) ? oneOf('BLOCK_PROVIDER_CALLS', block.trim(), ['0', '1']) === '1' : false,
    ffmpegPath: present(ffmpeg) ? ffmpeg.trim() : null,
  }
}

/** Class C. Throws when it is missing on local/preview, invalid, or set at all on production. */
export function parseImageQualityDevCap(source: EnvSource, appEnv: AppEnv): ImageQuality | null {
  const raw = source.IMAGE_QUALITY_DEV_CAP
  if (appEnv === 'production') {
    if (present(raw)) throw new EnvError('IMAGE_QUALITY_DEV_CAP', 'must not be set on production')
    return null
  }
  return oneOf('IMAGE_QUALITY_DEV_CAP', required(source, 'IMAGE_QUALITY_DEV_CAP'), IMAGE_QUALITIES)
}

function parseModels(source: EnvSource, appEnv: AppEnv, warnings: string[]) {
  const b = (name: ClassBVar): string => {
    const raw = source[name]
    if (present(raw)) return raw.trim()
    if (appEnv !== 'local') throw new EnvError(name, `is required on ${appEnv} and is not set`)
    warnings.push(`${name}=${LOCAL_FALLBACK[name]}`)
    return LOCAL_FALLBACK[name]
  }
  const model = (name: ClassBVar): string => {
    const id = b(name)
    if (!isPricedClaudeModel(id)) throw new EnvError(name, `"${id}" has no rate in claude-rates.ts`)
    return id
  }
  const cap = (name: ClassBVar): number => int(name, b(name), CAP_MIN, CAP_MAX)

  const claude: ClaudeEnv = {
    shotsModel: model('CLAUDE_SHOTS_MODEL'),
    shotOutlineMaxTokens: cap('CLAUDE_SHOT_OUTLINE_MAX_TOKENS'),
    shotsMaxTokens: cap('CLAUDE_SHOTS_MAX_TOKENS'),
    cameraModel: model('CLAUDE_CAMERA_MODEL'),
    cameraMaxTokens: cap('CLAUDE_CAMERA_MAX_TOKENS'),
    agentModel: model('CLAUDE_AGENT_MODEL'),
    agentMaxTokens: cap('CLAUDE_AGENT_MAX_TOKENS'),
    imagePromptsModel: model('CLAUDE_IMAGE_PROMPTS_MODEL'),
    imagePromptsMaxTokens: cap('CLAUDE_IMAGE_PROMPTS_MAX_TOKENS'),
    musicPromptModel: model('CLAUDE_MUSIC_PROMPT_MODEL'),
    musicPromptMaxTokens: cap('CLAUDE_MUSIC_PROMPT_MAX_TOKENS'),
  }
  const elevenlabs = {
    voiceoverProvider: oneOf('VOICEOVER_PROVIDER', b('VOICEOVER_PROVIDER'), SUPPORTED_ELEVENLABS.provider),
    voiceoverModel: oneOf('ELEVENLABS_VOICEOVER_MODEL', b('ELEVENLABS_VOICEOVER_MODEL'), SUPPORTED_ELEVENLABS.voiceoverModel),
    musicProvider: oneOf('MUSIC_PROVIDER', b('MUSIC_PROVIDER'), SUPPORTED_ELEVENLABS.provider),
    musicModel: oneOf('ELEVENLABS_MUSIC_MODEL', b('ELEVENLABS_MUSIC_MODEL'), SUPPORTED_ELEVENLABS.musicModel),
  }
  return { claude, elevenlabs }
}

/** Validates `source` for one process kind. Throws EnvError naming the first bad var. */
export function parseEnv<S extends EnvScope>(source: EnvSource, scope: S): ParsedEnv<S> {
  const appEnv = parseAppEnv(source)
  const warnings: string[] = []
  if (scope === 'worker') {
    const env: WorkerEnv = { appEnv, supabase: parseSupabase(source), spendCap: parseSpendCap(source), tuning: parseTuning(source) }
    return { env, warnings } as ParsedEnv<S>
  }
  const secret = required(source, 'INTERNAL_CONTINUATION_SECRET')
  if (secret.length < SECRET_MIN_LENGTH) {
    throw new EnvError('INTERNAL_CONTINUATION_SECRET', `must be at least ${SECRET_MIN_LENGTH} characters`)
  }
  const env: NextEnv = {
    appEnv,
    supabase: { ...parseSupabase(source), anonKey: required(source, 'NEXT_PUBLIC_SUPABASE_ANON_KEY') },
    providerKeys: {
      anthropic: required(source, 'ANTHROPIC_API_KEY'),
      openai: required(source, 'OPENAI_API_KEY'),
      elevenlabs: required(source, 'ELEVENLABS_API_KEY'),
    },
    continuationSecret: secret,
    spendCap: parseSpendCap(source),
    ...parseModels(source, appEnv, warnings),
    imageQualityDevCap: parseImageQualityDevCap(source, appEnv),
    tuning: parseTuning(source),
  }
  return { env, warnings } as ParsedEnv<S>
}

const tokens = (n: number) => `${n.toLocaleString('en-US')} tokens`

/** The resolved, non-secret config as label/value rows, for the boot log. */
export function describeEnv(env: NextEnv | WorkerEnv): [label: string, value: string][] {
  const rows: [string, string][] = [['Environment', env.appEnv]]
  if ('claude' in env) {
    const c = env.claude
    rows.push(
      ['Shot generation', `${c.shotsModel}  (outline max ${tokens(c.shotOutlineMaxTokens)}, chunk max ${tokens(c.shotsMaxTokens)})`],
      ['Camera', `${c.cameraModel}  (max ${tokens(c.cameraMaxTokens)})`],
      ['Agent', `${c.agentModel}  (max ${tokens(c.agentMaxTokens)})`],
      ['Image prompts', `${c.imagePromptsModel}  (max ${tokens(c.imagePromptsMaxTokens)})`],
      ['Music prompt', `${c.musicPromptModel}  (max ${tokens(c.musicPromptMaxTokens)})`],
      ['Voiceover', `${env.elevenlabs.voiceoverProvider} / ${env.elevenlabs.voiceoverModel}`],
      ['Music', `${env.elevenlabs.musicProvider} / ${env.elevenlabs.musicModel}`],
      ['Image quality cap', env.imageQualityDevCap ?? 'none']
    )
  }
  rows.push(
    ['Spend cap', env.spendCap.enabled ? `on, $${env.spendCap.monthlyUsd} per month` : 'off'],
    ['Provider calls', env.tuning.blockProviderCalls ? 'blocked' : 'allowed']
  )
  return rows
}

const reported = new Set<EnvScope>()

/**
 * The boot check: validate the live process env, warn once per local default, and log the
 * resolved config once per process. Throws on any invalid or missing var, so nothing that
 * runs after it starts.
 */
export function validateAtBoot(scope: EnvScope, options: { log: boolean } = { log: true }): void {
  const { env, warnings } = parseEnv(process.env, scope)
  if (!options.log || reported.has(scope)) return
  reported.add(scope)
  for (const w of warnings) {
    const [name, value] = [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]
    console.warn(`[env] ${name} is not set, so local uses its dev value: ${value}`)
  }
  const rows = describeEnv(env)
  const width = Math.max(...rows.map(([label]) => label.length)) + 2
  console.log(`[env] Resolved configuration (${scope === 'worker' ? 'export worker' : 'app'})`)
  for (const [label, value] of rows) console.log(`[env]   ${`${label}:`.padEnd(width)}${value}`)
}

/** The app environment. Inlined into client and edge bundles by next.config.ts's `env`. */
export function appEnv(): AppEnv {
  return parseAppEnv({ APP_ENV: process.env.APP_ENV })
}

/** Preview and production share every production-only decision; only local is not production. */
export function isProduction(): boolean {
  return appEnv() !== 'local'
}

/** The NEXT_PUBLIC_* pair, by literal access so Next inlines them into the browser bundle. */
export function publicEnv(): { supabaseUrl: string; supabaseAnonKey: string } {
  return {
    supabaseUrl: required({ NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL }, 'NEXT_PUBLIC_SUPABASE_URL'),
    supabaseAnonKey: required(
      { NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      'NEXT_PUBLIC_SUPABASE_ANON_KEY'
    ),
  }
}

/** Which Next runtime this code is running in (instrumentation.ts). */
export function nextRuntime(): string | undefined {
  return process.env.NEXT_RUNTIME
}

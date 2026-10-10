import 'server-only'
import { IMAGE_QUALITIES, type ImageQuality } from './enums'
import { imageQualityDevCap, serverEnv } from './env.server'
import type { ClaudeReasoning } from './models'

// Per-call Claude and ElevenLabs config. Every model id and max_tokens comes from env
// (env.ts class B): required on preview and production, the dev value on local. There is
// no code default for production - the production/dev model split lives in the deployed
// env, validated at boot. Reasoning settings are code, not env.

export type ModelsConfig = {
  // Shot generation's outline call: the scenes, in order. Same model as the chunks.
  shotOutline: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  // Shot generation's chunk calls: up to SHOTS_PER_CHUNK shots of one scene each
  // (config/shots.ts). maxTokens is sized with it so a chunk finishes well inside 300s.
  shots: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  camera: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  agent: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  // Quality is not here: it is the project's own `image_quality`, through
  // effectiveImageQuality.
  // Element reference images. The model and provider come from resolveImageModel; the
  // quality is the project's. Storyboard frames have no section: their size follows the
  // project's aspect ratio (STORYBOARD_IMAGE_SIZES, storyboard.ts).
  elements: {
    size: '1024x1024'
  }
  imagePrompts: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  // Voices are not here: they are a per-language list, VOICEOVER_VOICES in models.ts.
  voiceover: {
    provider: 'elevenlabs'
    model: string
  }
  music: {
    provider: 'elevenlabs'
    model: string
  }
  musicPrompt: {
    provider: 'anthropic'
    model: string
    maxTokens: number
    reasoning: ClaudeReasoning
  }
  // Future steps (video prompts) each get their own section here as they're
  // implemented - keep this type and the object below in sync.
}

// Built on first use, not at import: a module that imports this one (a spec being listed,
// a route being compiled) must not need the environment yet. The boot check has already
// validated it by the time any request reads a section. Built once, so a section is one
// object for the life of the process.
let built: ModelsConfig | null = null

function build(): ModelsConfig {
  const env = serverEnv()
  const claude = env.claude
  return {
    shotOutline: {
      provider: 'anthropic',
      model: claude.shotsModel,
      maxTokens: claude.shotOutlineMaxTokens,
      reasoning: { thinking: 'disabled', effort: 'medium' },
    },
    shots: {
      provider: 'anthropic',
      model: claude.shotsModel,
      maxTokens: claude.shotsMaxTokens,
      reasoning: { thinking: 'disabled', effort: 'medium' },
    },
    camera: {
      provider: 'anthropic',
      // Haiku in every environment, production included - a locked cost decision. Deriving
      // 1-3 enum values from a sentence is mechanical work that never benefits from Sonnet's
      // extra quality, and this call fires on nearly every visual-description blur.
      model: claude.cameraModel,
      // Small ceiling on purpose: reserveUsage reserves the FULL max_tokens as its
      // worst-case pre-flight quote (see src/lib/usage/quote.ts), and this call fires on
      // nearly every description edit. 500 leaves room for the new tokenizer's ~30% more
      // tokens on a 1-3 enum-field answer without a shots-scale reservation.
      maxTokens: claude.cameraMaxTokens,
      reasoning: { thinking: 'disabled', effort: 'low' },
    },
    agent: {
      provider: 'anthropic',
      model: claude.agentModel,
      maxTokens: claude.agentMaxTokens,
      // The one route with tool_choice auto, so the only one where thinking runs.
      reasoning: { thinking: 'adaptive', effort: 'medium' },
    },
    elements: {
      size: '1024x1024',
    },
    imagePrompts: {
      provider: 'anthropic',
      model: claude.imagePromptsModel,
      maxTokens: claude.imagePromptsMaxTokens,
      reasoning: { thinking: 'disabled', effort: 'medium' },
    },
    voiceover: {
      provider: env.elevenlabs.voiceoverProvider,
      // eleven_v3 is required: scripts carry inline audio tags ([slowly], [warmly]) that
      // older models would read aloud as words.
      model: env.elevenlabs.voiceoverModel,
    },
    music: {
      provider: env.elevenlabs.musicProvider,
      // Instrumental only - the request always sets force_instrumental.
      model: env.elevenlabs.musicModel,
    },
    musicPrompt: {
      provider: 'anthropic',
      // Haiku in every environment, like camera: one short line of instruments, mood and
      // tempo is mechanical summarising, fired once per project and free to the user.
      model: claude.musicPromptModel,
      // Small ceiling for the same reason as camera: reserveUsage reserves all of it.
      maxTokens: claude.musicPromptMaxTokens,
      reasoning: { thinking: 'disabled', effort: 'low' },
    },
  }
}

const sections = (): ModelsConfig => (built ??= build())

export const modelsConfig: ModelsConfig = {
  get shotOutline() { return sections().shotOutline },
  get shots() { return sections().shots },
  get camera() { return sections().camera },
  get agent() { return sections().agent },
  get elements() { return sections().elements },
  get imagePrompts() { return sections().imagePrompts },
  get voiceover() { return sections().voiceover },
  get music() { return sections().music },
  get musicPrompt() { return sections().musicPrompt },
}

// The quality an image request actually sends - and is priced at. Off production,
// IMAGE_QUALITY_DEV_CAP lowers it (never raises it) to keep spend down; production always
// sends the project's own quality. Gate, provider call and ledger all read this one
// function, so the charge always follows the quality actually used.
export function effectiveImageQuality(projectQuality: ImageQuality): ImageQuality {
  const cap = imageQualityDevCap()
  if (!cap) return projectQuality
  return IMAGE_QUALITIES[Math.min(IMAGE_QUALITIES.indexOf(projectQuality), IMAGE_QUALITIES.indexOf(cap))]
}

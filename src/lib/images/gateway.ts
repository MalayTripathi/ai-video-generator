import OpenAI, { toFile } from 'openai'
import { IMAGE_SDK_TIMEOUT_MS } from '@/lib/config/storyboard'

export interface ReferenceImageResult {
  imageBuffer: Buffer
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface StoryboardImageResult {
  imageBuffer: Buffer
  usage: {
    /** The provider's total input, text and image together. */
    input_tokens: number
    /** The reference-image share of input_tokens (0 for a text-only generation). */
    image_input_tokens: number
    output_tokens: number
  }
}

export interface ImageGateway {
  generateReferenceImage(params: {
    prompt: string
    model: string
    quality: string
    size: string
  }): Promise<ReferenceImageResult>
  // A shot's storyboard image. With reference images (the shot's bound elements) it goes
  // through the edit endpoint, which takes them as input; with none, a plain generation.
  generateStoryboardImage(params: {
    prompt: string
    model: string
    quality: string
    size: string
    references: Buffer[]
  }): Promise<StoryboardImageResult>
}

export class ImageLiveCallsBlockedError extends Error {
  constructor() {
    super(
      'Blocked a real, billed OpenAI image call: live calls outside production ' +
        'require ALLOW_REAL_OPENAI_IMAGES=1, and this flag is set by the developer only.'
    )
    this.name = 'ImageLiveCallsBlockedError'
  }
}

// Mirrors assertLiveCallsAllowed (src/lib/claude.ts) exactly - this is the first
// non-Claude paid call in the codebase, and it gets the same safety net. Never set,
// export, or add ALLOW_REAL_OPENAI_IMAGES anywhere in this repo's own env files, npm
// scripts, test config, or CI - whether to spend money on a live call is the
// developer's decision alone.
export function assertLiveImageCallsAllowed(): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_REAL_OPENAI_IMAGES === '1') return

  throw new ImageLiveCallsBlockedError()
}

export function createImageGateway(): ImageGateway {
  return {
    async generateReferenceImage(params) {
      assertLiveImageCallsAllowed()

      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[images] LIVE call outside production — provider=openai model=${params.model}`)
      }

      // maxRetries: 0 - same reasoning as ClaudeGateway: an SDK-level retry on a
      // partially generated response would be a silent second charge. This route's
      // own "one call, no retry" rule already forbids retrying at a higher level;
      // this just makes sure the SDK doesn't do it invisibly underneath that.
      const client = new OpenAI({ maxRetries: 0, timeout: 120_000 })

      const response = await client.images.generate({
        model: params.model,
        prompt: params.prompt,
        size: params.size as OpenAI.Images.ImageGenerateParams['size'],
        quality: params.quality as OpenAI.Images.ImageGenerateParams['quality'],
        n: 1,
      })

      const b64 = response.data?.[0]?.b64_json
      if (!b64) {
        throw new Error('OpenAI returned no image data')
      }

      return {
        imageBuffer: Buffer.from(b64, 'base64'),
        // Real measured counts from the API response - never synthesized from
        // OPENAI_RATES, which is a pricing table, not a source of truth for usage.
        usage: {
          input_tokens: response.usage?.input_tokens ?? 0,
          output_tokens: response.usage?.output_tokens ?? 0,
        },
      }
    },

    async generateStoryboardImage(params) {
      assertLiveImageCallsAllowed()

      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[images] LIVE call outside production — provider=openai model=${params.model} references=${params.references.length}`
        )
      }

      // maxRetries: 0 for the same silent-second-charge reason as above. The timeout comes
      // from storyboard.ts, where the claim's stale window is derived from it.
      const client = new OpenAI({ maxRetries: 0, timeout: IMAGE_SDK_TIMEOUT_MS })

      const response =
        params.references.length > 0
          ? await client.images.edit({
              model: params.model,
              prompt: params.prompt,
              image: await Promise.all(
                params.references.map((buffer, i) => toFile(buffer, `reference-${i + 1}.webp`, { type: 'image/webp' }))
              ),
              size: params.size as OpenAI.Images.ImageEditParams['size'],
              quality: params.quality as OpenAI.Images.ImageEditParams['quality'],
              n: 1,
            })
          : await client.images.generate({
              model: params.model,
              prompt: params.prompt,
              size: params.size as OpenAI.Images.ImageGenerateParams['size'],
              quality: params.quality as OpenAI.Images.ImageGenerateParams['quality'],
              n: 1,
            })

      const b64 = response.data?.[0]?.b64_json
      if (!b64) {
        throw new Error('OpenAI returned no image data')
      }

      return {
        imageBuffer: Buffer.from(b64, 'base64'),
        usage: {
          input_tokens: response.usage?.input_tokens ?? 0,
          image_input_tokens: response.usage?.input_tokens_details?.image_tokens ?? 0,
          output_tokens: response.usage?.output_tokens ?? 0,
        },
      }
    },
  }
}

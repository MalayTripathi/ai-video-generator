import sharp from 'sharp'
import type { ImageGateway } from '../../src/lib/images/gateway'

const DEFAULT_USAGE = { input_tokens: 50, output_tokens: 272 }

// A real, tiny, decodable PNG - not arbitrary bytes. uploadNormalizedReferenceObject
// (src/lib/elements/reference.ts) runs every generated image through sharp for real
// (format-sniffing, resize, re-encode to webp), the same as a manual upload, so a fake
// gateway that returns non-image bytes would be correctly rejected by that validation
// rather than exercising the success path this fake exists to test.
let cachedFakeImageBuffer: Buffer | null = null
async function fakeImageBuffer(): Promise<Buffer> {
  if (!cachedFakeImageBuffer) {
    cachedFakeImageBuffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer()
  }
  return cachedFakeImageBuffer
}

export type StoryboardCall = { prompt: string; model: string; quality: string; size: string; referenceCount: number }
export type ReferenceCall = { model: string; quality: string; size: string }

const DEFAULT_STORYBOARD_USAGE = { input_tokens: 80, image_input_tokens: 0, output_tokens: 1200 }

// A real PNG at exactly the requested WxH, so a test can assert the stored image keeps
// the generation size (and so its aspect ratio) end to end.
async function fakeImageAt(size: string): Promise<Buffer> {
  const [width, height] = size.split('x').map(Number)
  return sharp({ create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } } })
    .png()
    .toBuffer()
}

type FakeImageGateway = ImageGateway & {
  getCallCount: () => number
  /** Storyboard calls only, in order, with what each was asked for. */
  getStoryboardCalls: () => StoryboardCall[]
  /** Element-reference calls only, in order, with what each was asked for. */
  getReferenceCalls: () => ReferenceCall[]
}

/** A fake ImageGateway that succeeds once per call and counts how many times it was
 * invoked - the "exactly one provider call" assertion every generate test needs.
 * Mirrors claude-fakes.ts's shape (successMessage/throwingGateway), adapted for the fact
 * every scenario here cares about call count, not just the result shape. `storyboardUsage`
 * may be a function of the call, to report image-input tokens only when references were
 * passed. */
export function successImageGateway(
  usage: { input_tokens: number; output_tokens: number } = DEFAULT_USAGE,
  imageBuffer?: Buffer,
  storyboardUsage:
    | { input_tokens: number; image_input_tokens: number; output_tokens: number }
    | ((call: StoryboardCall) => { input_tokens: number; image_input_tokens: number; output_tokens: number }) =
    DEFAULT_STORYBOARD_USAGE
): FakeImageGateway {
  let callCount = 0
  const storyboardCalls: StoryboardCall[] = []
  const referenceCalls: ReferenceCall[] = []
  return {
    async generateReferenceImage(params) {
      callCount++
      referenceCalls.push({ model: params.model, quality: params.quality, size: params.size })
      return { imageBuffer: imageBuffer ?? (await fakeImageBuffer()), usage }
    },
    async generateStoryboardImage(params) {
      callCount++
      const call = {
        prompt: params.prompt,
        model: params.model,
        quality: params.quality,
        size: params.size,
        referenceCount: params.references.length,
      }
      storyboardCalls.push(call)
      return {
        imageBuffer: await fakeImageAt(params.size),
        usage: typeof storyboardUsage === 'function' ? storyboardUsage(call) : storyboardUsage,
      }
    },
    getCallCount: () => callCount,
    getStoryboardCalls: () => [...storyboardCalls],
    getReferenceCalls: () => [...referenceCalls],
  }
}

/** A fake ImageGateway whose call always throws - simulates a hard API/network
 * failure. Pass an Error instance (e.g. ImageLiveCallsBlockedError) to throw it
 * directly rather than wrapping a message in a plain Error. */
export function throwingImageGateway(error: Error | string = 'simulated OpenAI image failure'): FakeImageGateway {
  let callCount = 0
  const storyboardCalls: StoryboardCall[] = []
  const fail = () => {
    throw typeof error === 'string' ? new Error(error) : error
  }
  return {
    async generateReferenceImage() {
      callCount++
      return fail()
    },
    async generateStoryboardImage(params) {
      callCount++
      storyboardCalls.push({
        prompt: params.prompt,
        model: params.model,
        quality: params.quality,
        size: params.size,
        referenceCount: params.references.length,
      })
      return fail()
    },
    getCallCount: () => callCount,
    getStoryboardCalls: () => [...storyboardCalls],
    getReferenceCalls: () => [],
  }
}

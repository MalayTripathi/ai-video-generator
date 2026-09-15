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

/** A fake ImageGateway that succeeds once per call and counts how many times it was
 * invoked - the "exactly one provider call" assertion every generate-reference test
 * needs. Mirrors claude-fakes.ts's shape (successMessage/throwingGateway), adapted for
 * the fact every scenario here cares about call count, not just the result shape. */
export function successImageGateway(
  usage: { input_tokens: number; output_tokens: number } = DEFAULT_USAGE,
  imageBuffer?: Buffer
): ImageGateway & { getCallCount: () => number } {
  let callCount = 0
  return {
    async generateReferenceImage() {
      callCount++
      return { imageBuffer: imageBuffer ?? (await fakeImageBuffer()), usage }
    },
    getCallCount: () => callCount,
  }
}

/** A fake ImageGateway whose call always throws - simulates a hard API/network
 * failure. Pass an Error instance (e.g. ImageLiveCallsBlockedError) to throw it
 * directly rather than wrapping a message in a plain Error. */
export function throwingImageGateway(
  error: Error | string = 'simulated OpenAI image failure'
): ImageGateway & { getCallCount: () => number } {
  let callCount = 0
  return {
    async generateReferenceImage() {
      callCount++
      throw typeof error === 'string' ? new Error(error) : error
    },
    getCallCount: () => callCount,
  }
}

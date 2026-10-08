import { parseBuffer } from 'music-metadata'

// Server-side audio facts the voiceover pipeline needs: a stored read's length (for the
// per-minute price, the upload limit, and each chunk's time offset) and the joined read.

/** Duration in seconds, measured from the audio itself. Null when it can't be read. */
export async function measureDurationSec(audio: Buffer, mime: string): Promise<number | null> {
  try {
    const meta = await parseBuffer(new Uint8Array(audio), { mimeType: mime, size: audio.length }, { duration: true })
    const seconds = meta.format.duration
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null
  } catch (err) {
    console.error('[voiceover] could not read audio duration', err)
    return null
  }
}

// MPEG-1 Layer III bitrates (kbps) by header index, and sample rates by index - the only
// variant the provider's mp3_44100_128 output uses.
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG1_RATES = [44100, 48000, 32000]

// Drops a leading ID3v2 tag, a trailing ID3v1 tag, and a leading Xing/Info frame (the
// VBR/length header an encoder writes as the first frame). Those describe one file; left
// inside a joined stream they make a player report the first part's length as the whole.
export function stripMp3Headers(input: Buffer): Buffer {
  let buf = input
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    const footer = buf[5] & 0x10 ? 10 : 0
    buf = buf.subarray(Math.min(buf.length, 10 + size + footer))
  }
  if (buf.length >= 128 && buf.toString('latin1', buf.length - 128, buf.length - 125) === 'TAG') {
    buf = buf.subarray(0, buf.length - 128)
  }
  // First frame header: sync, MPEG-1 (version bits 11), Layer III (layer bits 01).
  if (buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xfe) === 0xfa) {
    const kbps = MPEG1_L3_KBPS[buf[2] >> 4]
    const rate = MPEG1_RATES[(buf[2] >> 2) & 0x03]
    if (kbps && rate) {
      const frameLength = Math.floor((144000 * kbps) / rate) + ((buf[2] >> 1) & 0x01)
      const mono = (buf[3] >> 6) === 0x03
      const tagAt = 4 + (mono ? 17 : 32)
      const tag = buf.toString('latin1', tagAt, tagAt + 4)
      if ((tag === 'Xing' || tag === 'Info') && frameLength <= buf.length) buf = buf.subarray(frameLength)
    }
  }
  return buf
}

/**
 * Joins mp3 parts into one read. Every part comes from the same output format
 * (mp3_44100_128), so their frames concatenate directly into a playable stream once each
 * part's own file headers are removed. A single part is stored exactly as it arrived.
 */
export function concatMp3(parts: readonly Buffer[]): Buffer {
  if (parts.length === 1) return parts[0]
  return Buffer.concat(parts.map(stripMp3Headers))
}

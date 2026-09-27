import type { AspectRatio, CaptionMode, CaptionPosition, CaptionStyle, ExportMotion, LoudnessPreset, Motion, Transition } from './enums'

// Step 4 storyboard image generation: every size, timing and encoding number lives here,
// never at a call site and never in env. Model/provider/quality are env-driven and live
// in models.ts (modelsConfig.storyboardImages) instead.

// Native generation sizes, one per project aspect ratio - generated at exactly the
// ratio, so no crop is needed before the image becomes Step 6's first frame. Each is a
// multiple of 16 on both edges, within the 1:3-3:1 ratio range, under the 3840px edge
// cap and inside the 655,360-8,294,400 pixel budget OpenAI documents for the
// gpt-image-2.5 family.
export const STORYBOARD_IMAGE_SIZES: Record<AspectRatio, string> = {
  '9:16': '1008x1792',
  '16:9': '1792x1008',
  '1:1': '1088x1088',
}

// The provider SDK's own request timeout for one image call.
export const IMAGE_SDK_TIMEOUT_MS = 120_000

// How long a started image claim may run before it reads as failed (and becomes
// reclaimable). Must exceed the SDK timeout plus reference download, encode, upload and
// the row writes, with margin - the worker also refuses to link or charge a shot past
// this point, so the display and the charge can never disagree.
export const IMAGE_STALE_AFTER_MS = IMAGE_SDK_TIMEOUT_MS + 60_000

// Route maxDuration for /api/projects/[id]/images, in seconds (Next's segment config
// must be a literal in the route file itself - this is the value it mirrors, checked by
// a test).
export const IMAGES_ROUTE_MAX_DURATION_S = 800

// One background run stops starting new shots after this, then drains what's in flight
// and hands the rest to a continuation. Budget + one full stale window stays under the
// route's maxDuration, so a shot started at the last moment still finishes in-run.
export const RUN_TIME_BUDGET_MS = 600_000

// How many times a batch may hand itself to a continuation run. Shots still queued when
// this is reached are settled failed, uncharged.
export const CONTINUATION_CHAIN_LIMIT = 8

// The longest a claim can legitimately sit queued: every run in the chain spending its
// full budget plus a stale window. Past this, a queued claim reads as failed.
export const IMAGE_QUEUE_STALE_AFTER_MS = (CONTINUATION_CHAIN_LIMIT + 1) * (RUN_TIME_BUDGET_MS + IMAGE_STALE_AFTER_MS)

// Parallel provider calls per run. Kept low: a low-tier OpenAI account's images-per-
// minute limit is small, and a 429 settles the shot failed and uncharged.
export const IMAGE_CONCURRENCY = 3

// How often the Storyboard page's status poll should run (consumer built in A2).
export const STATUS_POLL_INTERVAL_MS = 3000

// sharp WebP quality for stored storyboard images - high, since these become video
// first frames.
export const STORYBOARD_WEBP_QUALITY = 90

// Width of the lane thumbnail written beside each stored image (`{attemptId}_thumb.webp`).
// The picture lane draws at most ~30px wide, so this is generous for any DPR.
export const STORYBOARD_THUMB_WIDTH = 240

// Lifetime of the signed image URLs the status endpoint returns. Comfortably longer than a
// poll cycle; every poll re-signs, and an idle page re-signs shortly before expiry.
export const STORYBOARD_SIGNED_URL_EXPIRES_S = 3600

// Estimate of one image call, for the generating block's progress rule and ETA only. It is
// a display figure - nothing times out or settles on it.
export const IMAGE_ETA_ESTIMATE_MS = 45_000

// Retime (Storyboard B2). The shortest and longest a boundary drag or Fit to voiceover can
// make a shot. The video model's clip limit does not apply here - Step 6 handles a shot
// longer than one clip.
export const STORYBOARD_MIN_SHOT_SEC = 1.0
export const STORYBOARD_MAX_SHOT_SEC = 30

// Retimed lengths snap to this step, on drag and on each keyboard nudge.
export const RETIME_SNAP_SEC = 0.1

// Zoom levels for the timeline's −/Fit/+, as multiples of the Fit scale. Index 0 is Fit,
// the default; past Fit the lane scrolls horizontally.
export const STORYBOARD_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const

// While a drag is within this many pixels of the lane's edge, the zoomed lane scrolls.
export const LANE_AUTOSCROLL_EDGE_PX = 48

// Fastest auto-scroll, in pixels per animation frame, reached at the very edge.
export const LANE_AUTOSCROLL_MAX_PX = 14

// A press that moves less than this is a click (it selects the shot), never a drag.
export const DRAG_THRESHOLD_PX = 4

// Voiceover (Storyboard C1). Voices and the model live in models.ts; every size, limit and
// timing number lives here.

// eleven_v3's per-request character limit (GET /v1/models, max_characters_request_*). A
// longer script is read in several requests, split between shots, never mid-shot.
export const VOICEOVER_CHUNK_MAX_CHARS = 5000

// The most requests one voiceover may take. Bounds the whole read's length and, with the
// timeout below, the claim's stale window.
export const VOICEOVER_MAX_CHUNKS = 4

export const VOICEOVER_MAX_SCRIPT_CHARS = VOICEOVER_CHUNK_MAX_CHARS * VOICEOVER_MAX_CHUNKS

// The provider request timeout for one text-to-speech or alignment call.
export const VOICEOVER_REQUEST_TIMEOUT_MS = 150_000

// How long a started voiceover claim may run before it reads as failed: every chunk at
// its full timeout plus storage writes, with margin.
export const VOICEOVER_STALE_AFTER_MS = VOICEOVER_MAX_CHUNKS * (VOICEOVER_REQUEST_TIMEOUT_MS + 30_000) + 60_000

// The same for an uploaded read's alignment: one call.
export const VOICEOVER_ALIGN_STALE_AFTER_MS = VOICEOVER_REQUEST_TIMEOUT_MS + 90_000

// Route maxDuration for the voiceover routes, in seconds (mirrors the literal in each
// route file; the stale windows above must fit inside it).
export const VOICEOVER_ROUTE_MAX_DURATION_S = 800

// Uploads: what may be aligned. The file goes straight to Storage through a signed upload
// URL, so these are checked when the URL is issued and again on the stored object.
export const VOICEOVER_UPLOAD_FORMATS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
}
export const VOICEOVER_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export const VOICEOVER_UPLOAD_MAX_SEC = 15 * 60

// Display-only estimates for the generating state's progress line and ETA. Nothing times
// out or settles on them.
export const VOICEOVER_SPOKEN_CHARS_PER_SEC = 15
export const VOICEOVER_ETA_CHARS_PER_SEC = 60
export const VOICEOVER_ALIGN_ETA_MS = 20_000

// Below this timeline-header width, Fit to voiceover collapses to its icon with a tooltip.
export const FIT_COLLAPSE_BREAKPOINT_PX = 720

// Motion & transitions (Storyboard B3): the tunables. The motion and transition lists are
// enums (enums.ts); their display labels live in motion-labels.ts.

// Alternate: every shot without its own motion takes this cycle by film position, skipping
// any move equal to the previous shot's, so two consecutive shots never repeat a move.
export const ALTERNATE_MOTION_CYCLE: readonly Motion[] = ['push_in', 'pan_left', 'pull_out', 'pan_right']

// The film defaults: a null motion / transition_out follows the project's export setting
// (projects.export_motion / export_transition), and a null setting follows these.
export const FILM_DEFAULT_MOTION: ExportMotion = 'alternate'
export const FILM_DEFAULT_TRANSITION: Transition = 'dissolve'

// A dissolve's length, centred on the join, capped at half the shorter neighbouring shot.
export const DISSOLVE_SEC = 0.5

// A new split lands here, as a fraction of the shot's length.
export const DEFAULT_SPLIT_AT = 0.5

// Preview & mix (Storyboard E). One film timeline (src/lib/storyboard/film.ts) drives the
// client player and, later, the export render - so every number both read lives here.

// How far a push in / pull out travels: the still is drawn at 1 → MOTION_ZOOM (or back).
export const MOTION_ZOOM = 1.12

// How far a pan travels across its segment, as a percentage of the frame. The still is
// held at MOTION_PAN_SCALE throughout so the edge never shows.
export const MOTION_PAN_PCT = 8
export const MOTION_PAN_SCALE = 1.1

// The mix: gains and duck depth in dB. Null in a project column means the default here.
export type MixRange = { min: number; max: number; default: number }
export const MIX_VOICE_GAIN_DB: MixRange = { min: -24, max: 6, default: 0 }
export const MIX_MUSIC_GAIN_DB: MixRange = { min: -36, max: 0, default: -14 }
export const MIX_DUCK_DEPTH_DB: MixRange = { min: -24, max: 0, default: -9 }
// Slider values snap to this many dB.
export const MIX_STEP_DB = 0.5

// Ducking is deterministic: the music is lowered by the duck depth over each spoken word,
// reaching full depth over the attack before the word and recovering over the release after
// it - from the word timings, never live analysis, so preview and export duck identically.
export const DUCK_ATTACK_SEC = 0.08
export const DUCK_RELEASE_SEC = 0.35

// A slider saves once it has been still this long.
export const MIX_SAVE_DEBOUNCE_MS = 400

// The Preview player's box per aspect ratio (canvas 15b/15i): 9:16 is 480px tall, 1:1 is
// 400 × 400. 16:9 departs from 15i's full section width: it is capped at the same 480px
// height as 9:16, so the mix can sit beside it.
export const PREVIEW_PLAYER_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 270, height: 480 },
  '1:1': { width: 400, height: 400 },
  '16:9': { width: 853, height: 480 },
}

// The narrowest the mix panel may be beside the player - the 1:1 case at 1440 in canvas
// 15i. Narrower than this and the mix stacks below the player instead.
export const PREVIEW_MIX_MIN_WIDTH_PX = 372

// The mini player's long edge (canvas 15h).
export const MINI_PLAYER_LONG_EDGE_PX = 240

// Export (Storyboard F). Render tunables that are not per-project live in export.ts; the
// film-level defaults and presets live here beside the other film defaults.

// The rendered film's frame size per aspect ratio.
export const EXPORT_OUTPUT_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
}

// Export settings defaults: what a null projects column means.
export const FILM_DEFAULT_CAPTION_MODE: CaptionMode = 'off'
export const FILM_DEFAULT_CAPTION_STYLE: CaptionStyle = 'reelcraft_default'
export const FILM_DEFAULT_CAPTION_POSITION: CaptionPosition = 'bottom'
export const FILM_DEFAULT_LOUDNESS: LoudnessPreset = 'streaming'

// Caption lines are grouped from the voiceover's word timings: a line ends before a word
// that would take it past this many characters, at a pause of at least this long between
// two words, and at every shot boundary.
export const CAPTION_MAX_CHARS_PER_LINE = 32
export const CAPTION_PAUSE_BREAK_SEC = 0.4

// Burned-in caption styles. Only the exposed presets are offered in settings; sizes are
// fractions of the frame height so one preset reads the same at every resolution.
export type CaptionStylePreset = {
  font: string
  fontSizeFrac: number
  bold: boolean
  /** ASS colours, &HAABBGGRR. */
  primary: string
  outline: string
  outlineFrac: number
  shadowFrac: number
  /** Vertical margin from the frame edge for 'bottom', as a fraction of the frame height. */
  marginFrac: number
}
export const CAPTION_STYLE_PRESETS: Record<CaptionStyle, CaptionStylePreset> = {
  reelcraft_default: {
    font: 'Inter',
    fontSizeFrac: 0.042,
    bold: true,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    outlineFrac: 0.0035,
    shadowFrac: 0.0015,
    marginFrac: 0.09,
  },
}
export const EXPOSED_CAPTION_STYLES: readonly CaptionStyle[] = ['reelcraft_default']

// Loudness targets for ffmpeg's two-pass loudnorm: integrated (LUFS), true peak (dBTP),
// loudness range (LU).
export const LOUDNESS_TARGETS: Record<LoudnessPreset, { i: number; tp: number; lra: number }> = {
  streaming: { i: -14, tp: -1, lra: 11 },
  podcast: { i: -16, tp: -1.5, lra: 11 },
  broadcast: { i: -23, tp: -2, lra: 15 },
}

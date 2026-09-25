'use client'

import { MINI_PLAYER_LONG_EDGE_PX, STORYBOARD_IMAGE_SIZES } from '@/lib/config/storyboard'
import { useStoryboard } from './storyboard-context'
import { usePlayback, usePlaybackEngine } from './playback-context'
import { FilmPicture, useNowLine } from './film-picture'

// The mini player (canvas 15h): while playing with Preview & mix scrolled off-screen, the
// picture and the line being spoken dock bottom-right of the main column, above the footer.
// Closing it pauses; scrolling Preview back into view hides it.
export function MiniPlayer() {
  const { aspectRatio } = useStoryboard()
  const engine = usePlaybackEngine()
  const { playing, previewVisible, miniClosed } = usePlayback()
  const line = useNowLine()
  if (!playing || previewVisible || miniClosed) return null
  const [w, h] = STORYBOARD_IMAGE_SIZES[aspectRatio].split('x').map(Number)
  const width = w >= h ? MINI_PLAYER_LONG_EDGE_PX : Math.round((MINI_PLAYER_LONG_EDGE_PX * w) / h)
  const height = w >= h ? Math.round((MINI_PLAYER_LONG_EDGE_PX * h) / w) : MINI_PLAYER_LONG_EDGE_PX
  return (
    <div
      data-testid="mini-player"
      className="absolute bottom-[16px] right-rc-lg z-20 flex flex-col overflow-hidden rounded-control border border-border-strong bg-bg-surface shadow-card"
      style={{ width }}
    >
      <div className="relative" style={{ width, height }}>
        <FilmPicture className="h-full w-full" />
        <button
          type="button"
          data-testid="mini-player-close"
          aria-label="Close and pause"
          title="Close and pause"
          onClick={() => engine.closeMini()}
          className="absolute right-[6px] top-[6px] flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-badge bg-bg-canvas text-text-secondary hover:bg-bg-inset hover:text-text-primary"
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
      </div>
      {line && (
        <div className="my-[7px] ml-[9px] overflow-hidden text-ellipsis whitespace-nowrap border-l-2 border-ident-voiceover-fg pl-[7px] pr-[9px] text-meta text-text-secondary">
          {line}
        </div>
      )}
    </div>
  )
}

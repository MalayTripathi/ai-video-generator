'use client'

import type { CSSProperties } from 'react'
import { lineAt, visualsAt } from '@/lib/storyboard/film'
import { useStoryboard } from './storyboard-context'
import { usePlayback } from './playback-context'

// The picture at the shared playhead: the film's one or two visible stills, each drawn with
// its motion as a transform and faded in through a dissolve. The Preview player and the
// mini player both draw this; the export renders the same layers from the same timeline.
export function FilmPicture({ className = '', style, testId }: { className?: string; style?: CSSProperties; testId?: string }) {
  const { film, statusFor, shots } = useStoryboard()
  const { t } = usePlayback()
  const layers = visualsAt(film, t)
  const number = (shotId: string) => (shots.find((s) => s.id === shotId)?.order_index ?? 0) + 1
  return (
    <div
      data-testid={testId}
      data-shot-id={layers[layers.length - 1]?.segment.shotId ?? ''}
      className={`relative overflow-hidden bg-bg-well ${className}`}
      style={style}
    >
      {layers.map(({ segment, opacity, transform }) => {
        const url = statusFor(segment.shotId).imageUrl
        return url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
          <img
            key={`${segment.shotId}:${segment.part}`}
            src={url}
            alt={`Shot ${number(segment.shotId)}`}
            draggable={false}
            className="absolute inset-0 block h-full w-full select-none object-cover"
            style={{
              opacity,
              transform: `translate(${transform.xPct}%, ${transform.yPct}%) scale(${transform.scale})`,
              transformOrigin: 'center',
            }}
          />
        ) : null
      })}
    </div>
  )
}

/** The narration at the playhead, for "Voiceover · Now" and the mini player. */
export function useNowLine(): string | null {
  const { film } = useStoryboard()
  const { t } = usePlayback()
  return lineAt(film, t)?.text ?? null
}

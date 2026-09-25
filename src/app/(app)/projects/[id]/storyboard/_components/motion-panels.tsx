'use client'

import { MOTIONS, TRANSITIONS, type Motion, type Transition } from '@/lib/config/enums'
import { DEFAULT_SPLIT_AT } from '@/lib/config/storyboard'
import { MOTION_LABELS, TRANSITION_LABELS } from '@/lib/motion-labels'
import { FORCED_CUT_REASON, motionSummary, splitUnavailableReason } from '@/lib/storyboard/motion'
import { filmSeconds } from '@/lib/storyboard/timeline'
import { useStoryboard } from './storyboard-context'

const PANEL =
  'flex min-w-0 flex-1 flex-col gap-[8px] rounded-frame border border-border-subtle bg-bg-canvas p-[11px_13px]'
const PANEL_LABEL = 'text-label uppercase tracking-label text-text-tertiary'
const CELL =
  'flex h-[28px] cursor-pointer items-center justify-center whitespace-nowrap px-[9px] text-small disabled:cursor-not-allowed disabled:opacity-60'

function cellTone(active: boolean): string {
  return active ? 'bg-bg-inset font-medium text-text-primary' : 'bg-bg-canvas text-text-secondary hover:bg-bg-inset'
}

// Selected shot (canvas 15d): the seven motions plus Film default, which clears the
// shot's own motion so it follows the film again; then Split / Remove split.
function SelectedShotPanel() {
  const { laneShots, motions, selectedSegment, setMotion, setSplit, selectSegment, readOnly } = useStoryboard()
  const shot = selectedSegment ? laneShots.find((s) => s.id === selectedSegment.shotId) : undefined
  const resolved = shot ? motions.get(shot.id) : undefined
  if (!shot || !selectedSegment || !resolved) return null

  const split = resolved.splitAt !== null
  const segment = split ? selectedSegment.segment : 'a'
  const stored = segment === 'a' ? resolved.storedMotion : resolved.storedSplitMotion
  const playing = segment === 'a' ? resolved.motion : resolved.splitMotion
  const number = shot.order_index + 1
  const title = split ? `${number}${segment}` : String(number)
  const splitReason = split ? null : splitUnavailableReason(filmSeconds(shot))

  const choose = (motion: Motion | null) => {
    if (motion !== stored) setMotion(shot.id, segment, motion)
  }

  return (
    <div data-testid="selected-shot-panel" className={PANEL}>
      <span className={PANEL_LABEL}>Selected shot · {title}</span>
      <div
        role="group"
        aria-label="Motion"
        className="grid grid-cols-4 gap-px overflow-hidden rounded-control border border-border-strong bg-border-subtle"
      >
        {MOTIONS.map((motion) => (
          <button
            key={motion}
            type="button"
            aria-pressed={stored === motion}
            disabled={readOnly}
            onClick={() => choose(motion)}
            className={`${CELL} ${cellTone(stored === motion)}`}
          >
            {MOTION_LABELS[motion]}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={stored === null}
          disabled={readOnly}
          title={playing ? `Follows the film's motion - plays ${MOTION_LABELS[playing]} here` : undefined}
          onClick={() => choose(null)}
          className={`${CELL} ${cellTone(stored === null)}`}
        >
          Film default
        </button>
      </div>
      <div className="flex items-center gap-[10px]">
        {split ? (
          <button
            type="button"
            disabled={readOnly}
            onClick={() => setSplit(shot.id, null)}
            className="flex h-[28px] cursor-pointer items-center rounded-control border border-border-strong px-[11px] text-small text-text-primary hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60"
          >
            Remove split
          </button>
        ) : (
          <button
            type="button"
            disabled={readOnly || splitReason !== null}
            onClick={() => {
              setSplit(shot.id, DEFAULT_SPLIT_AT)
              selectSegment({ shotId: shot.id, segment: 'a' })
            }}
            className="flex h-[28px] cursor-pointer items-center rounded-control border border-border-strong px-[11px] text-small text-text-primary hover:bg-bg-inset disabled:cursor-not-allowed disabled:opacity-60"
          >
            Split
          </button>
        )}
        {splitReason && (
          <span data-testid="split-unavailable" className="text-meta text-text-tertiary">
            {splitReason}
          </span>
        )}
        {split && (
          <span className="text-meta text-text-quiet">Plays {motionSummary(resolved, MOTION_LABELS)}</span>
        )}
      </div>
      <span className="text-meta leading-[1.45] text-text-tertiary">
        A split divides one shot into two motion segments of the same image. Downstream this is still one shot — the dashed
        marker, not a join.
      </span>
    </div>
  )
}

// Selected join (canvas 15d): Cut or Dissolve. A forced cut shows Cut and says why; the
// stored choice is untouched, so a later retime can release it.
function SelectedJoinPanel() {
  const { laneShots, joins, selectedJoinShotId, setTransition, readOnly } = useStoryboard()
  const join = selectedJoinShotId ? joins.find((j) => j.shotId === selectedJoinShotId) : undefined
  if (!join) return null
  const from = laneShots.find((s) => s.id === join.shotId)
  const to = laneShots.find((s) => s.id === join.nextShotId)
  if (!from || !to) return null

  const choose = (transition: Transition) => {
    if (transition !== join.chosen) setTransition(join.shotId, transition)
  }

  return (
    <div data-testid="selected-join-panel" className={PANEL}>
      <span className={PANEL_LABEL}>
        Selected join · {from.order_index + 1} → {to.order_index + 1}
      </span>
      <div
        role="group"
        aria-label="Transition"
        className="flex items-center self-start overflow-hidden rounded-control border border-border-strong"
      >
        {TRANSITIONS.map((transition, i) => (
          <button
            key={transition}
            type="button"
            aria-pressed={join.transition === transition}
            disabled={readOnly}
            onClick={() => choose(transition)}
            className={`flex h-[28px] cursor-pointer items-center px-[11px] text-small disabled:cursor-not-allowed disabled:opacity-60 ${
              i > 0 ? 'border-l border-border-subtle' : ''
            } ${join.transition === transition ? 'bg-bg-inset font-medium text-text-primary' : 'text-text-secondary hover:bg-bg-inset'}`}
          >
            {TRANSITION_LABELS[transition]}
          </button>
        ))}
      </div>
      {join.forced ? (
        <span data-testid="forced-cut-reason" className="text-meta leading-[1.45] text-text-secondary">
          {FORCED_CUT_REASON}
        </span>
      ) : (
        <span className="text-meta leading-[1.45] text-text-tertiary">
          A join that lands inside a spoken word is forced to a cut — the control shows Cut and says why rather than going
          blank.
        </span>
      )}
    </div>
  )
}

export function MotionPanels() {
  const { mode, selectedSegment, selectedJoinShotId } = useStoryboard()
  if (mode !== 'motion' || (!selectedSegment && !selectedJoinShotId)) return null
  return (
    <div data-testid="motion-panels" className="flex items-stretch gap-[14px]">
      <SelectedShotPanel />
      <SelectedJoinPanel />
    </div>
  )
}

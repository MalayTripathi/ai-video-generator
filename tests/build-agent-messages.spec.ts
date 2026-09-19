import { test, expect } from '@playwright/test'
import { buildAgentMessages } from '../src/lib/build-agent-messages'
import { describeToolActivity } from '../src/lib/agent-activity-display'
import type { Tables } from '../src/lib/database.types'

type MessageRow = Tables<'messages'>

let seq = 0
function row(overrides: Partial<MessageRow> & { role: string }): MessageRow {
  seq++
  return {
    id: `m${seq}`,
    project_id: 'p1',
    content: '',
    kind: 'text',
    shot_key: null,
    tool_name: null,
    client_id: null,
    created_at: new Date(seq * 1000).toISOString(),
    ...overrides,
  } as MessageRow
}

test.describe('buildAgentMessages', () => {
  test('a simple turn: user, tool_done, closing reply, and a cost line when the turn has spend', () => {
    const userRow = row({ role: 'user', content: 'do it', client_id: 'c1' })
    const toolRow = row({ role: 'assistant', kind: 'tool_done', tool_name: 'update_shot', shot_key: 'sk1', content: 'Updated Shot 1' })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Done.', client_id: 'c1' })

    const out = buildAgentMessages(
      [userRow, toolRow, replyRow],
      new Map([['sk1', 1]]),
      new Map([[userRow.id, 0.1]]),
      new Map([[userRow.id, 17]])
    )

    expect(out.map((m) => m.kind)).toEqual(['user', 'tool_done', 'agent', 'cost'])
    expect(out[1].content).toBe('Updated Shot 1')
    expect(out[3].amount).toBe('$0.100')
    expect(out[3].creditAmount).toBe('17 cr')
  })

  test('a cost line with no matching credit_ledger row renders the dollar figure alone - never "0 cr"', () => {
    const userRow = row({ role: 'user', content: 'do it', client_id: 'c1' })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Done.', client_id: 'c1' })

    const out = buildAgentMessages([userRow, replyRow], new Map(), new Map([[userRow.id, 0.1]]), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'agent', 'cost'])
    expect(out[2].amount).toBe('$0.100')
    expect(out[2].creditAmount).toBeUndefined()
  })

  test('no cost line when the turn summed to zero', () => {
    const userRow = row({ role: 'user', content: 'do it', client_id: 'c1' })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Done.', client_id: 'c1' })

    const out = buildAgentMessages([userRow, replyRow], new Map(), new Map(), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'agent'])
  })

  test('a refusal row persists and renders its content verbatim, no re-derivation', () => {
    const userRow = row({ role: 'user', content: 'delete shot 1', client_id: 'c1' })
    const refusalRow = row({ role: 'assistant', kind: 'refusal', content: "I can't delete shots." })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Explained why not.', client_id: 'c1' })

    const out = buildAgentMessages([userRow, refusalRow, replyRow], new Map(), new Map(), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'refusal', 'agent'])
    expect(out[1].content).toBe("I can't delete shots.")
  })

  test('a turn that declines via a mid-turn refusal (no client_id) still gets its ordinary closing reply and cost line, not folded into the refusal', () => {
    const userRow = row({ role: 'user', content: 'delete shot 1', client_id: 'c1' })
    const declineRow = row({
      role: 'assistant',
      kind: 'refusal',
      content: "There's no delete tool - use the shot's own delete button.",
    })
    const closingRow = row({ role: 'assistant', kind: 'text', content: "I can't delete shots directly.", client_id: 'c1' })

    const out = buildAgentMessages([userRow, declineRow, closingRow], new Map(), new Map([[userRow.id, 0.05]]), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'refusal', 'agent', 'cost'])
    expect(out[1].content).toBe("There's no delete tool - use the shot's own delete button.")
    expect(out[2].content).toBe("I can't delete shots directly.")
  })

  test('a closing reply matching the turn\'s client_id always renders as completed, never abandoned, regardless of what tool/decline activity preceded it - completion detection is client_id-based, not tied to any particular tool having been called', () => {
    const userRow = row({ role: 'user', content: 'delete shot 3 and rewrite shot 2', client_id: 'c1' })
    const declineRow = row({ role: 'assistant', kind: 'refusal', content: "There's no delete tool." })
    const toolRow = row({ role: 'assistant', kind: 'tool_done', tool_name: 'update_shot', shot_key: 'sk1', content: 'Updated Shot 2' })
    const closingRow = row({ role: 'assistant', kind: 'text', content: 'Declined the delete, rewrote shot 2.', client_id: 'c1' })

    const out = buildAgentMessages([userRow, declineRow, toolRow, closingRow], new Map([['sk1', 2]]), new Map(), new Map())

    expect(out.some((m) => m.kind === 'error')).toBe(false)
    expect(out.map((m) => m.kind)).toEqual(['user', 'refusal', 'tool_done', 'agent'])
    expect(out[3].content).toBe('Declined the delete, rewrote shot 2.')
  })

  test('a mid-list abandoned turn (no closing reply before the next user row) renders as error with no cost, and the next turn still parses correctly', () => {
    const abandonedUser = row({ role: 'user', content: 'first turn', client_id: 'c1' })
    // No assistant row at all for this turn - straight to the next user row.
    const secondUser = row({ role: 'user', content: 'second turn', client_id: 'c2' })
    const secondReply = row({ role: 'assistant', kind: 'text', content: 'Second done.', client_id: 'c2' })

    const out = buildAgentMessages(
      [abandonedUser, secondUser, secondReply],
      new Map(),
      new Map([[abandonedUser.id, 0.75]]), // even if present, must never be shown for the abandoned turn
      new Map()
    )

    expect(out.map((m) => m.kind)).toEqual(['user', 'error', 'user', 'agent'])
    expect(out[1].content).toBe('This turn never finished, so nothing was changed.')
    expect(out[1].retryContent).toBe('first turn')
    expect(out[1].retryClientId).toBe('c1')
    expect(out.some((m) => m.kind === 'cost')).toBe(false)
  })

  test('a trailing abandoned turn (last row, no closing reply, end of list) renders as error', () => {
    const userRow = row({ role: 'user', content: 'never finished', client_id: 'c9' })

    const out = buildAgentMessages([userRow], new Map(), new Map(), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'error'])
    expect(out[1].retryClientId).toBe('c9')
  })

  test('an interstitial prose row (e.g. runShotGeneration\'s own nested message, client_id null) does not get mistaken for the turn\'s closing reply', () => {
    const userRow = row({ role: 'user', content: 'regenerate everything', client_id: 'turn-client-id' })
    const nestedRow = row({ role: 'assistant', kind: 'text', content: 'Generated 4 fresh shots.', client_id: null })
    const toolRow = row({ role: 'assistant', kind: 'tool_done', tool_name: 'regenerate_all_shots', content: 'Regenerated all shots' })
    const closingRow = row({ role: 'assistant', kind: 'text', content: 'All set.', client_id: 'turn-client-id' })

    const out = buildAgentMessages([userRow, nestedRow, toolRow, closingRow], new Map(), new Map(), new Map())

    // The nested message renders as an ordinary interstitial bubble, in position - it is
    // NOT treated as the turn's end, and the real closing reply still renders afterward.
    expect(out.map((m) => m.kind)).toEqual(['user', 'agent', 'tool_done', 'agent'])
    expect(out[1].content).toBe('Generated 4 fresh shots.')
    expect(out[3].content).toBe('All set.')
  })

  test('a user row with no client_id (legacy, pre-client_id-column) falls back to "first text row wins"', () => {
    const userRow = row({ role: 'user', content: 'legacy turn', client_id: null })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Legacy reply.', client_id: null })

    const out = buildAgentMessages([userRow, replyRow], new Map(), new Map(), new Map())

    expect(out.map((m) => m.kind)).toEqual(['user', 'agent'])
    expect(out[1].content).toBe('Legacy reply.')
  })

  test('two user messages with identical text and different client identifiers, whose replies arrive out of order, each render with their own reply and neither renders as abandoned', () => {
    // Reproduces the reported interleaving: tab A sends first and is still mid-flight
    // (slow, real tool activity) when tab B sends the identical text and gets an
    // near-instant refusal - so B's whole exchange lands in storage before A's own
    // activity and reply do, even though A was sent first.
    const userA = row({ role: 'user', content: 'insert a shot here', client_id: 'a' })
    const userB = row({ role: 'user', content: 'insert a shot here', client_id: 'b' })
    const replyB = row({
      role: 'assistant',
      kind: 'text',
      content: 'Another turn was already running for this project when this was sent, so nothing was changed.',
      client_id: 'b',
    })
    const toolA = row({ role: 'assistant', kind: 'tool_done', tool_name: 'insert_shot', content: 'Inserted a new shot' })
    const replyA = row({ role: 'assistant', kind: 'text', content: 'Inserted the shot.', client_id: 'a' })

    const out = buildAgentMessages([userA, userB, replyB, toolA, replyA], new Map(), new Map(), new Map())

    expect(out.some((m) => m.kind === 'error')).toBe(false)

    const userEntries = out.filter((m) => m.kind === 'user')
    expect(userEntries.map((m) => m.id)).toEqual([userA.id, userB.id])

    const replyForA = out.find((m) => m.kind === 'agent' && m.id === replyA.id)
    const replyForB = out.find((m) => m.kind === 'agent' && m.id === replyB.id)
    expect(replyForA?.content).toBe('Inserted the shot.')
    expect(replyForB?.content).toBe(
      'Another turn was already running for this project when this was sent, so nothing was changed.'
    )
    expect(out.some((m) => m.kind === 'tool_done' && m.id === toolA.id)).toBe(true)
  })

  test('tool_done for a shot whose key no longer resolves renders the deleted-shot fallback', () => {
    const userRow = row({ role: 'user', content: 'do it', client_id: 'c1' })
    const toolRow = row({ role: 'assistant', kind: 'tool_done', tool_name: 'update_shot', shot_key: 'gone', content: 'Updated Shot 3' })
    const replyRow = row({ role: 'assistant', kind: 'text', content: 'Done.', client_id: 'c1' })

    const out = buildAgentMessages([userRow, toolRow, replyRow], new Map(), new Map(), new Map())

    expect(out[1].content).toBe("Updated a shot that's since been deleted")
  })
})

test.describe('describeToolActivity', () => {
  test('renders verb + current shot number when the key resolves', () => {
    expect(describeToolActivity('update_shot', 4, 'fallback')).toBe('Updated Shot 4')
    expect(describeToolActivity('get_shot', 1, 'fallback')).toBe('Looked at Shot 1')
  })

  test('the Step 3 regeneration tools re-derive their text live: single is shot-scoped, all ignores any number', () => {
    expect(describeToolActivity('regenerate_image_prompt', 2, 'fallback')).toBe('Rewrote Shot 2 prompt')
    expect(describeToolActivity('regenerate_image_prompt', null, 'fallback')).toBe(
      "Rewrote a prompt for a shot that's since been deleted"
    )
    expect(describeToolActivity('regenerate_all_image_prompts', 5, 'fallback')).toBe('Rewrote all image prompts')
  })

  test('regenerate_all_shots ignores any shot number - it is never shot-scoped', () => {
    expect(describeToolActivity('regenerate_all_shots', 5, 'fallback')).toBe('Regenerated all shots')
    expect(describeToolActivity('regenerate_all_shots', null, 'fallback')).toBe('Regenerated all shots')
  })

  test('insert_shot with no resolved number gets its own non-alarming fallback, not "deleted"', () => {
    expect(describeToolActivity('insert_shot', null, 'fallback')).toBe('Inserted a new shot')
  })

  test('update_shot/get_shot with no resolved number reads as a deleted shot', () => {
    expect(describeToolActivity('update_shot', null, 'fallback')).toBe("Updated a shot that's since been deleted")
    expect(describeToolActivity('get_shot', null, 'fallback')).toBe("Looked at a shot that's since been deleted")
  })

  test('an unrecognized tool name falls back to the given text', () => {
    expect(describeToolActivity('not_a_real_tool', 1, 'the raw label')).toBe('the raw label')
  })
})

import { test, expect } from '@playwright/test'
import { callClaudeOrCleanup, type ClaudeGateway, type MessagesGateway } from '../src/app/api/projects/[id]/script/logic'
import type Anthropic from '@anthropic-ai/sdk'

const MESSAGE_ID = 'msg-1'
const PARAMS = {} as Anthropic.MessageCreateParamsNonStreaming

function fakeMessagesStore(seed: string[]) {
  const rows = new Set(seed)
  const gateway: MessagesGateway = {
    deleteMessage: async (id) => {
      rows.delete(id)
      return { error: null }
    },
  }
  return { rows, gateway }
}

test.describe('script route: cleanup on failed Claude call', () => {
  test('deletes the orphaned user message when the Claude call throws', async () => {
    const { rows, gateway } = fakeMessagesStore([MESSAGE_ID])
    const claude: ClaudeGateway = {
      createMessage: async () => {
        throw new Error('network error')
      },
    }

    const result = await callClaudeOrCleanup(claude, gateway, MESSAGE_ID, PARAMS)

    expect(result.ok).toBe(false)
    expect(rows.has(MESSAGE_ID)).toBe(false)
  })

  test('deletes the orphaned user message when Claude returns no content blocks', async () => {
    const { rows, gateway } = fakeMessagesStore([MESSAGE_ID])
    const claude: ClaudeGateway = {
      createMessage: async () =>
        ({ content: [], usage: {} }) as unknown as Anthropic.Message,
    }

    const result = await callClaudeOrCleanup(claude, gateway, MESSAGE_ID, PARAMS)

    expect(result.ok).toBe(false)
    expect(rows.has(MESSAGE_ID)).toBe(false)
  })

  test('keeps the user message and returns the response on success', async () => {
    const { rows, gateway } = fakeMessagesStore([MESSAGE_ID])
    const response = {
      content: [{ type: 'text', text: 'hello' }],
      usage: {},
    } as unknown as Anthropic.Message
    const claude: ClaudeGateway = {
      createMessage: async () => response,
    }

    const result = await callClaudeOrCleanup(claude, gateway, MESSAGE_ID, PARAMS)

    expect(result).toEqual({ ok: true, response })
    expect(rows.has(MESSAGE_ID)).toBe(true)
  })
})

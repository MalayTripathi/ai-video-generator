import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { admin } from './supabase-test-session'
import { primary } from './fixed-users'
import {
  IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS,
  parseImagePromptsInstruction,
} from '../src/lib/prompts/image-prompts'

// POST /api/projects/[id]/image-prompts gains an optional `instruction` string next to
// shotIds. Absent (or blank) it changes nothing; present it is validated before any DB
// read or model call and handed to the runner, which sends it to the model and stores it
// nowhere (see image-prompts-agent-path.spec.ts).

test.describe('parseImagePromptsInstruction', () => {
  test('absent, null and blank all mean no instruction', () => {
    for (const raw of [undefined, null, '', '   ', '\n\t ']) {
      expect(parseImagePromptsInstruction(raw)).toEqual({ ok: true, instruction: null })
    }
  })

  test('a real instruction is trimmed', () => {
    expect(parseImagePromptsInstruction('  make it feel colder \n')).toEqual({
      ok: true,
      instruction: 'make it feel colder',
    })
  })

  test('the limit is on the trimmed text, inclusive', () => {
    const atLimit = 'x'.repeat(IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS)
    expect(parseImagePromptsInstruction(`  ${atLimit}  `)).toEqual({ ok: true, instruction: atLimit })
    const over = parseImagePromptsInstruction(atLimit + 'x')
    expect(over.ok).toBe(false)
  })

  test('anything that is not a string is rejected, never coerced', () => {
    for (const raw of [5, true, {}, [], ['a']]) {
      expect(parseImagePromptsInstruction(raw).ok).toBe(false)
    }
  })
})

async function seedProject() {
  const { data, error } = await admin
    .from('projects')
    .insert({
      user_id: primary.user.id,
      title: 'Route instruction test',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: 3,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

test.describe('POST /api/projects/[id]/image-prompts - instruction validation', () => {
  const UNKNOWN_SHOT = '00000000-0000-4000-8000-000000000000'

  test('a non-string instruction is a 400 before any read or spend', async ({ page }) => {
    const projectId = await seedProject()
    const res = await page.request.post(`/api/projects/${projectId}/image-prompts`, {
      data: { shotIds: [UNKNOWN_SHOT], instruction: 5 },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/instruction/i)
  })

  test('an over-long instruction is a 400 naming the limit', async ({ page }) => {
    const projectId = await seedProject()
    const res = await page.request.post(`/api/projects/${projectId}/image-prompts`, {
      data: { shotIds: [UNKNOWN_SHOT], instruction: 'x'.repeat(IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS + 1) },
    })
    expect(res.status()).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/instruction/i)
    expect(error).toContain(String(IMAGE_PROMPTS_INSTRUCTION_MAX_CHARS))
  })

  test('a valid, blank or absent instruction passes validation and reaches the runner (which refuses the unknown shot)', async ({
    page,
  }) => {
    const projectId = await seedProject()
    for (const instruction of ['make it feel colder', '   ', undefined]) {
      const res = await page.request.post(`/api/projects/${projectId}/image-prompts`, {
        data: { shotIds: [UNKNOWN_SHOT], ...(instruction === undefined ? {} : { instruction }) },
      })
      // The runner's own scope check - proof the request got past route validation.
      expect(res.status()).toBe(400)
      expect((await res.json()).error).toMatch(/shotIds do not belong/i)
    }
  })

  test('the route hands the parsed instruction to runImagePromptGeneration', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/app/api/projects/[id]/image-prompts/route.ts'),
      'utf8'
    )
    const noComments = source.replace(/\/\/.*$/gm, '')
    expect(noComments).toMatch(/parseImagePromptsInstruction\(/)
    const call = noComments.slice(noComments.indexOf('runImagePromptGeneration({'))
    expect(call).toMatch(/\binstruction\b/)
  })
})

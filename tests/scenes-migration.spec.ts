import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { admin } from './supabase-test-session'

// Section labels became scenes: consecutive shots sharing a label were backfilled into one
// scene each, every reader switched to the scene title, and the column was dropped.

const ROOT = path.resolve(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full)
    return /\.(ts|tsx|mjs)$/.test(name) ? [full] : []
  })
}

test.describe('section labels are scenes', () => {
  test('shots.section_label no longer exists', async () => {
    const { error } = await admin.from('shots').select('section_label' as never).limit(1)
    expect(error?.code).toBe('42703') // undefined_column
  })

  test('no reader of section_label remains in the app, the worker or the generated types', () => {
    const offenders: string[] = []
    for (const file of [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'worker'))]) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Prompt version history may still name the old field in a comment.
          if (line.includes('section_label') && !line.trim().startsWith('//')) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  test('the backfill turns each run of consecutive labels into a scene, in order', () => {
    const sql = readFileSync(path.join(ROOT, 'supabase/migrations/20261009150318_backfill_scenes_from_section_label.sql'), 'utf8')
    // A run starts wherever the label differs from the previous shot's (by order_index),
    // and scenes are numbered from 0 per project in film order.
    expect(sql).toContain('is distinct from lag("section_label") over (partition by "project_id" order by "order_index")')
    expect(sql).toContain('dense_rank() over (partition by "project_id" order by "run_no") - 1')
    expect(sql).not.toMatch(/create (or replace )?function/i)
  })
})

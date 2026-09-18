import { test, expect, type Page } from '@playwright/test'
import { admin, createTestSession, deleteTestUser } from './supabase-test-session'
import { primary } from './fixed-users'

// The generation route is always mocked: these tests drive the client and the layout, never
// a model call. The balance preflight and saves go through the real server actions.

const PROMPT = (n: number) =>
  `Prompt ${n}: a wide establishing shot of the Taj Mahal at sunrise, soft light on white marble, reflections in the river, documentary framing.`

async function seed(
  userId: string,
  shots: { prompt: string | null; stale: boolean }[],
  generation: 'succeeded' | null = 'succeeded'
) {
  const { data: project, error } = await admin
    .from('projects')
    .insert({
      user_id: userId,
      title: 'Supplementary fixes',
      source_text: 'A short film.',
      video_type: 'auto',
      duration_target: '30-60s',
      current_step: 'image_prompts',
      furthest_step: 3,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  const projectId = project!.id as string
  if (generation) {
    const { error: genError } = await admin.from('generations').insert({
      project_id: projectId,
      step: 'image_prompts',
      operation: 'write_image_prompts',
      shot_id: null,
      state: generation,
    })
    expect(genError).toBeNull()
  }
  const { data, error: shotsError } = await admin
    .from('shots')
    .insert(
      shots.map((s, i) => ({
        project_id: projectId,
        order_index: i,
        shot_key: `sp${i}${Math.random().toString(36).slice(2, 4)}`,
        voice_over: `Voice over ${i}`,
        image_prompt: s.prompt,
        image_prompt_stale: s.stale,
      }))
    )
    .select('id, order_index')
  expect(shotsError).toBeNull()
  return { projectId, shotIds: data!.sort((a, b) => a.order_index - b.order_index).map((s) => s.id) }
}

async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((b) => /Regenerate All|Regenerate Stale/.test(b.textContent ?? ''))
    return !!button && Object.keys(button).some((k) => k.startsWith('__reactProps'))
  })
}

async function generationRows(projectId: string) {
  const { data } = await admin.from('generations').select('state, error').eq('project_id', projectId)
  return data!
}

async function sellOffBalance(userId: string, leave: number) {
  // Balance is the SUM of the ledger; the layout grants the signup credits on first load,
  // so this spend leaves exactly `leave` once that grant lands.
  const { error } = await admin.from('credit_ledger').insert({
    user_id: userId,
    kind: 'spend',
    delta: -(5000 - leave),
    dedupe_key: `test-drain-${crypto.randomUUID()}`,
    attempt_id: crypto.randomUUID(),
    pricing_mode: 'fixed',
    price_version: 'test',
    step: 'workbench',
    operation: 'generate_shots',
  })
  expect(error).toBeNull()
}

test.describe('1. balance is the first gate', () => {
  test('a refused regeneration never shows the writing state, never reaches the route, and leaves the generations row alone', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await sellOffBalance(user.id, 1)
      const { projectId } = await seed(user.id, [{ prompt: PROMPT(1), stale: true }])
      let routeCalls = 0
      await page.route('**/api/projects/*/image-prompts', async (route) => {
        routeCalls++
        await route.fulfill({ status: 500, body: '{}' })
      })
      await context.addCookies([cookie])
      await page.goto(`/projects/${projectId}/image_prompts`)
      await waitForHydration(page)

      // Record if the writing state ever appears, however briefly.
      await page.evaluate(() => {
        ;(window as unknown as { __sawWriting: boolean }).__sawWriting = false
        new MutationObserver(() => {
          if (/Regenerating…|Writing a new prompt/.test(document.body.innerText)) {
            ;(window as unknown as { __sawWriting: boolean }).__sawWriting = true
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true })
      })

      await page.getByRole('button', { name: /Regenerate Stale/ }).click()
      const banner = page.getByRole('alert').filter({ hasText: 'Not enough credits' })
      await expect(banner).toBeVisible()
      await expect(banner).toContainText('needs 2 credits')
      await expect(banner).toContainText('You have 1 credits available')

      expect(await page.evaluate(() => (window as unknown as { __sawWriting: boolean }).__sawWriting)).toBe(false)
      expect(routeCalls).toBe(0)
      expect(await generationRows(projectId)).toEqual([{ state: 'succeeded', error: null }])
      const { data: usage } = await admin.from('usage').select('id').eq('project_id', projectId)
      expect(usage).toEqual([])
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('arriving with no prompts and a short balance shows the banner instead of a writing state, and starts nothing', async ({
    page,
    context,
  }) => {
    const { user, cookie } = await createTestSession()
    try {
      await sellOffBalance(user.id, 1)
      const { projectId } = await seed(user.id, [{ prompt: null, stale: false }, { prompt: null, stale: false }], null)
      let routeCalls = 0
      await page.route('**/api/projects/*/image-prompts', async (route) => {
        routeCalls++
        await route.fulfill({ status: 500, body: '{}' })
      })
      await context.addCookies([cookie])
      await page.goto(`/projects/${projectId}/image_prompts`)

      await expect(page.getByRole('alert').filter({ hasText: 'Not enough credits' })).toBeVisible()
      await expect(page.getByText('Regenerating…')).toHaveCount(0)
      await expect(page.getByText('Writing…')).toHaveCount(0)
      await page.waitForTimeout(800)
      expect(routeCalls).toBe(0)
      expect(await generationRows(projectId)).toEqual([])
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('4. the rail refreshes when a generation settles', () => {
  test('the rail credits figure updates after a spend, and does not while merely refused', async ({ page, context }) => {
    const { user, cookie } = await createTestSession()
    try {
      const { projectId, shotIds } = await seed(user.id, [{ prompt: PROMPT(1), stale: true }])
      await page.route('**/api/projects/*/image-prompts', async (route) => {
        // The real route charges the ledger for what persisted; simulate exactly that.
        const { error } = await admin.from('credit_ledger').insert({
          user_id: user.id,
          kind: 'spend',
          delta: -2,
          dedupe_key: `test-spend-${crypto.randomUUID()}`,
          attempt_id: crypto.randomUUID(),
          pricing_mode: 'fixed',
          price_version: 'test',
          step: 'image_prompts',
          operation: 'write_image_prompts',
          project_id: projectId,
        })
        expect(error).toBeNull()
        const { data: rows } = await admin.from('shots').select('*').eq('project_id', projectId)
        expect(rows!.map((r) => r.id)).toEqual(shotIds)
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shots: rows }) })
      })
      await context.addCookies([cookie])
      await page.goto(`/projects/${projectId}/image_prompts`)
      await waitForHydration(page)

      await expect(page.getByTestId('rail-credits-spend')).toContainText('0 credits')
      await page.getByRole('button', { name: /Regenerate Stale/ }).click()
      await expect(page.getByTestId('rail-credits-spend')).toContainText('2 credits')
    } finally {
      await deleteTestUser(user.id)
    }
  })
})

test.describe('2, 3, 5. the card and the picker', () => {
  async function open(page: Page, shots: { prompt: string | null; stale: boolean }[]) {
    const { projectId } = await seed(primary.user.id, shots)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/projects/${projectId}/image_prompts`)
    await waitForHydration(page)
    return projectId
  }

  test('2. the icon control animates open on hover and moves nothing', async ({ page }) => {
    await open(page, [{ prompt: PROMPT(1), stale: false }])
    const button = page.getByRole('button', { name: /^Regenerate · \d+ credits$/ }).first()
    const slot = button.locator('xpath=..')
    const card = page.locator('div[aria-busy]').first()
    const title = card.getByText('Shot 1', { exact: true })
    const rect = (l: typeof slot) => l.evaluate((el) => JSON.stringify(el.getBoundingClientRect()))

    const before = { slot: await rect(slot), card: await rect(card), title: await rect(title) }
    const restWidth = (await button.boundingBox())!.width
    expect(restWidth).toBeLessThan(40)

    // The real transition: the label reveals via max-width (not a jump to `auto`), on the
    // system's own motion token.
    const reveal = button.locator('span[aria-hidden]').first()
    const transition = await reveal.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { property: cs.transitionProperty, duration: cs.transitionDuration }
    })
    expect(transition).toEqual({ property: 'max-width', duration: '0.12s' })

    // Measure the animation itself with the token slowed, so frame scheduling under load
    // cannot miss it: the width must pass through intermediate values on the way out.
    await page.evaluate(() => document.documentElement.style.setProperty('--motion', '900ms linear'))
    const samples = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const el = [...document.querySelectorAll('button')].find((b) => /^Regenerate · \d+ credits$/.test(b.getAttribute('aria-label') ?? ''))!
          const out: number[] = []
          const start = performance.now()
          const tick = () => {
            out.push(el.getBoundingClientRect().width)
            if (performance.now() - start < 1300) requestAnimationFrame(tick)
            else resolve(out)
          }
          tick()
        })
    )
    await button.hover()
    const widths = await samples

    const finalWidth = Math.max(...widths)
    expect(finalWidth).toBeGreaterThan(restWidth + 60)
    expect(finalWidth).toBeLessThan(200)
    const intermediate = widths.filter((w) => w > restWidth + 4 && w < finalWidth - 4)
    expect(intermediate.length).toBeGreaterThanOrEqual(5)
    // Monotonic on the way out: no overshoot, no jitter.
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] - 0.01)

    const after = { slot: await rect(slot), card: await rect(card), title: await rect(title) }
    expect(after).toEqual(before)

    await page.mouse.move(5, 5)
    await expect.poll(async () => (await button.boundingBox())!.width, { timeout: 5000 }).toBeLessThan(40)
  })

  test('3. the prompt box fits its text: short stays compact, long grows, editing shrinks it back, never a scrollbar', async ({
    page,
  }) => {
    await open(page, [
      { prompt: 'A short prompt.', stale: false },
      { prompt: PROMPT(2).repeat(4), stale: false },
    ])
    const fields = page.getByRole('textbox', { name: 'Image prompt' })
    const measure = (i: number) =>
      fields.nth(i).evaluate((el) => {
        const t = el as HTMLTextAreaElement
        return { height: t.getBoundingClientRect().height, overflows: t.scrollHeight > t.clientHeight + 1 }
      })

    const short = await measure(0)
    const long = await measure(1)
    expect(short.height).toBeLessThan(60)
    expect(long.height).toBeGreaterThan(short.height + 40)
    expect(short.overflows).toBe(false)
    expect(long.overflows).toBe(false)

    const first = fields.nth(0)
    await first.click()
    await first.fill(PROMPT(1).repeat(3))
    const grown = await measure(0)
    expect(grown.height).toBeGreaterThan(short.height + 40)
    expect(grown.overflows).toBe(false)

    await first.fill('A short prompt.')
    const shrunk = await measure(0)
    expect(Math.abs(shrunk.height - short.height)).toBeLessThanOrEqual(1)
  })

  test('5. the picker follows the canvas geometry with sentence-case labels', async ({ page }) => {
    const projectId = await open(page, [{ prompt: PROMPT(1), stale: false }])
    const { data: el } = await admin
      .from('elements')
      .insert([
        { project_id: projectId, name: 'Taj Mahal', type: 'location' },
        { project_id: projectId, name: 'Marble Slabs', type: 'prop' },
      ])
      .select('id')
    expect(el).toHaveLength(2)
    await page.reload()
    await waitForHydration(page)

    await page.getByRole('button', { name: 'Attach an element to this frame' }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    expect((await menu.boundingBox())!.width).toBe(300)
    // Neither element has a reference image, so each meta line carries both the type and
    // the quieted note - in sentence case, never the canvas's lowercase.
    await expect(menu.getByText('Location · No reference yet', { exact: true })).toBeVisible()
    await expect(menu.getByText('Prop · No reference yet', { exact: true })).toBeVisible()
    await expect(menu.getByText(/location · no reference yet/)).toHaveCount(0)
    await expect(menu.getByText(/prop · no reference yet/)).toHaveCount(0)

    const footer = menu.getByRole('button', { name: 'Upload or generate a new element' })
    const colours = await footer.evaluate((node) => {
      const cs = getComputedStyle(node)
      return { border: cs.borderColor, text: cs.color }
    })
    const accent = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--accent)'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    // Neutral, not accent-outlined.
    expect(colours.border).not.toBe(accent)
    expect(colours.text).not.toBe(accent)
  })
})

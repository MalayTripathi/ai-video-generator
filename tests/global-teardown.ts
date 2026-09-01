/**
 * Runs ONCE after the whole suite, never per-test. The suite runs at full parallelism
 * (playwright.config.ts's fullyParallel: true), so an afterEach-style cleanup of the
 * shared fixed test users' data would delete rows another in-flight test is still
 * asserting against - only a single post-run pass is safe.
 *
 * Scoped by the two fixed test users' explicit ids only (read from the same
 * tests/fixed-users.ts module every spec uses, so this can never drift from
 * global-setup.ts's identities) - never a truncate, never an unscoped delete, never a
 * pattern match. The auth users themselves are left in place; they're reused every run.
 *
 * usage.project_id is ON DELETE SET NULL, not CASCADE (confirmed against the applied
 * migration DDL, not assumed) - deleting projects first would orphan usage rows (null
 * out their project_id) rather than remove them, and they'd accumulate forever. usage
 * is deleted explicitly and first for exactly that reason. projects cascade cleanly to
 * shots/generations/elements/shot_elements (all ON DELETE CASCADE).
 *
 * A cleanup failure must not turn a green suite red - every failure here is logged
 * loudly and swallowed, never rethrown.
 */
export default async function globalTeardown() {
  try {
    const { admin } = await import('./supabase-test-session')
    const { primary, secondary } = await import('./fixed-users')
    const fixedUserIds = [primary.user.id, secondary.user.id]

    const { error: usageError, count: usageCount } = await admin
      .from('usage')
      .delete({ count: 'exact' })
      .in('user_id', fixedUserIds)
    if (usageError) {
      console.error('[global-teardown] usage delete failed:', usageError.message)
    } else {
      console.log(`[global-teardown] deleted ${usageCount ?? 0} usage row(s) for the fixed test users`)
    }

    const { error: projectsError, count: projectsCount } = await admin
      .from('projects')
      .delete({ count: 'exact' })
      .in('user_id', fixedUserIds)
    if (projectsError) {
      console.error('[global-teardown] projects delete failed:', projectsError.message)
    } else {
      console.log(`[global-teardown] deleted ${projectsCount ?? 0} project(s) for the fixed test users`)
    }
  } catch (err) {
    console.error('[global-teardown] cleanup failed entirely - suite result is unaffected:', err)
  }
}

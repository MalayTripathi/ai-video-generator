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
 * usage.project_id and credit_ledger.project_id are plain ids with no foreign key, so a
 * project delete never touches them (that is what keeps a deleted project's spend). They
 * are deleted explicitly and first, by user_id - otherwise they'd accumulate forever, since
 * the fixed users' auth rows (whose deletion would cascade them) are never deleted. projects
 * cascade to their child rows; deleted_projects rows are deleted by user_id after them.
 *
 * A cleanup failure must not turn a green suite red - every failure here is logged
 * loudly and swallowed, never rethrown.
 */
export default async function globalTeardown() {
  try {
    const { admin, pruneClaimedUsers } = await import('./supabase-test-session')
    const { primary, secondary } = await import('./fixed-users')
    const { removeStorageUnder } = await import('@/lib/storage/sweep')
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

    const { error: creditLedgerError, count: creditLedgerCount } = await admin
      .from('credit_ledger')
      .delete({ count: 'exact' })
      .in('user_id', fixedUserIds)
    if (creditLedgerError) {
      console.error('[global-teardown] credit_ledger delete failed:', creditLedgerError.message)
    } else {
      console.log(`[global-teardown] deleted ${creditLedgerCount ?? 0} credit_ledger row(s) for the fixed test users`)
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

    const { error: deletedProjectsError } = await admin.from('deleted_projects').delete().in('user_id', fixedUserIds)
    if (deletedProjectsError) console.error('[global-teardown] deleted_projects delete failed:', deletedProjectsError.message)

    // Storage doesn't cascade from projects: every fixed-user project is gone now, so
    // everything under the fixed users' own prefixes is orphaned.
    for (const userId of fixedUserIds) {
      try {
        const removed = await removeStorageUnder(admin, userId)
        console.log(`[global-teardown] removed ${removed} storage object(s) under ${userId}/`)
      } catch (err) {
        console.error(`[global-teardown] storage cleanup under ${userId}/ failed:`, err)
      }
    }

    // Last, so a pool problem can never skip the fixed users' cleanup above. Unclaimed
    // pool users stay for the next run.
    const pool = await pruneClaimedUsers()
    console.log(`[global-teardown] user pool: released ${pool.claimed} left claimed, ${pool.unused} free`)
  } catch (err) {
    console.error('[global-teardown] cleanup failed entirely - suite result is unaffected:', err)
  }
}

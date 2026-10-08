// Finishes the ledger entry the run guard wrote when it authorised this full run
// (playwright.config.ts adds this reporter for authorised full runs only).
import type { FullResult, Reporter, Suite } from '@playwright/test/reporter'
import { finalizeEntry } from './guard'

export default class LedgerReporter implements Reporter {
  private suite: Suite | undefined
  private readonly ledgerPath: string
  private readonly entryId: string

  constructor(options: { ledgerPath: string; entryId: string }) {
    this.ledgerPath = options.ledgerPath
    this.entryId = options.entryId
  }

  onBegin(_config: unknown, suite: Suite) {
    this.suite = suite
  }

  onEnd(result: FullResult) {
    const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 }
    for (const test of this.suite?.allTests() ?? []) {
      const outcome = test.outcome()
      if (outcome === 'expected') counts.passed++
      else if (outcome === 'unexpected') counts.failed++
      else if (outcome === 'flaky') counts.flaky++
      else counts.skipped++
    }
    finalizeEntry(this.ledgerPath, this.entryId, {
      ...counts,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(result.duration),
      status: result.status,
    })
  }
}

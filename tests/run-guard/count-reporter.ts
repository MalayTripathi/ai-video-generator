// Reporter for the run guard's --list child only (see playwright.config.ts): prints the
// number of tests the run would execute, as Playwright itself resolves them.
import type { Reporter, Suite } from '@playwright/test/reporter'
import { COUNT_MARKER } from './guard'

export default class CountReporter implements Reporter {
  onBegin(_config: unknown, suite: Suite) {
    process.stdout.write(`${COUNT_MARKER}${suite.allTests().length}\n`)
  }

  printsToStdio() {
    return true
  }
}

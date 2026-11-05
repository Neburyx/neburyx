export interface TestRun {
  /** The tests that failed, each with the message of its failure; none when the run passed. */
  readonly failures: ReadonlyArray<{ readonly title: string; readonly message: string }>;
  /** What went wrong outside the tests: an error of the runner or of a setup, or a process that ended badly with every test passed. */
  readonly errors: readonly string[];
  /** The tests that passed, so that a run in which nothing ran is not a pass. */
  readonly passed: number;
}

export interface MutationCheck {
  /** Runs the keyboard test the check is about on the app as it is built now. */
  readonly run: () => Promise<TestRun>;
  /** Breaks one binding in the source and builds the app again. */
  readonly breakBinding: () => Promise<void>;
  /** Puts the source back as it was and builds the app again. */
  readonly restore: () => Promise<void>;
  /** The test that must fail, by its title, and what its failure must say (an assertion, not another error). */
  readonly expected: { readonly title: string; readonly assertion: RegExp };
}

export interface MutationOutcome {
  readonly first: TestRun;
  readonly broken: TestRun;
  readonly restored: TestRun;
}

const NOT_AN_ASSERTION = /Timeout|TypeError|ReferenceError|NEVER_REACHED|locator\./;

/** Runs the keyboard test three times: as it is, with a binding broken, and after the source is put back; restores in every case, also when a step throws. Throws unless the first and last passed and the middle failed on the named test by its assertion. */
export async function checkBrokenBinding(check: MutationCheck): Promise<MutationOutcome> {
  const first = await check.run();
  if (first.errors.length > 0) throw new Error(`MUTATION_RUN_ERROR: ${first.errors.join('; ')}`);
  if (first.failures.length > 0) throw new Error(`MUTATION_BASELINE_FAILS: ${first.failures.map((failure) => failure.title).join('; ')}`);
  if (first.passed === 0) throw new Error('MUTATION_NO_TEST_RAN');
  let broken: TestRun;
  try {
    await check.breakBinding();
    broken = await check.run();
  } finally {
    await check.restore();
  }
  const restored = await check.run();
  if (broken.errors.length > 0) throw new Error(`MUTATION_RUN_ERROR: the run of the broken app: ${broken.errors.join('; ')}`);
  const named = broken.failures.filter((failure) => failure.title.includes(check.expected.title));
  if (named.length === 0) throw new Error(`MUTATION_NOT_CAUGHT: the broken binding failed ${broken.failures.length === 0 ? 'no test' : broken.failures.map((failure) => failure.title).join('; ')}, not "${check.expected.title}"`);
  const message = named[0]?.message ?? '';
  if (NOT_AN_ASSERTION.test(message) || !check.expected.assertion.test(message)) throw new Error(`MUTATION_WRONG_FAILURE: "${check.expected.title}" failed, but not on its assertion: ${message.slice(0, 200)}`);
  if (broken.failures.length !== named.length) throw new Error(`MUTATION_UNRELATED_FAILURES: ${broken.failures.filter((failure) => !named.includes(failure)).map((failure) => failure.title).join('; ')}`);
  if (restored.errors.length > 0 || restored.passed === 0) throw new Error(`MUTATION_RESTORE_FAILS: ${restored.errors.join('; ') || 'no test ran'}`);
  if (restored.failures.length > 0) throw new Error(`MUTATION_RESTORE_FAILS: ${restored.failures.map((failure) => failure.title).join('; ')}`);
  return { first, broken, restored };
}

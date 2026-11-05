export interface Interruptible {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface InterruptSteps {
  /** Stops what the check has running: the test run and the build. */
  readonly stopChildren: () => void;
  /** Puts the source file back as it was. */
  readonly restoreSource: () => void;
  /** Builds the app from the restored source, so the built app is not the broken one. */
  readonly rebuild: () => void;
  readonly exit: (code: number) => void;
}

/** On an interrupt: stop the children first (a build still running would write over the rebuilt app), then put the source back, then build it again, then leave. Runs once however many signals come. */
export function restoreOnInterrupt(source: Interruptible, steps: InterruptSteps): void {
  let handled = false;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    source.on(signal, () => {
      if (handled) return;
      handled = true;
      try {
        steps.stopChildren();
        steps.restoreSource();
        steps.rebuild();
      } finally {
        steps.exit(code);
      }
    });
  }
}

export interface Interruptible {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface InterruptSteps {
  /** Stops what the check has running, with everything that started, and gives back once it has all ended. */
  readonly stopChildren: () => Promise<void> | void;
  /** Puts the source file back as it was. */
  readonly restoreSource: () => void;
  /** Builds the app from the restored source, so the built app is not the broken one. */
  readonly rebuild: () => void;
  readonly exit: (code: number) => void;
  /** Says that a step failed; the interrupt goes on to the next step and then leaves. */
  readonly report: (error: unknown) => void;
}

/** On an interrupt: stop the children and wait until they have ended (a build still running would write over the rebuilt app), then put the source back, then build it again, then leave. A step that fails is reported and does not keep the next from running. Runs once however many signals come. */
export function restoreOnInterrupt(source: Interruptible, steps: InterruptSteps): void {
  let handled = false;
  const attempt = async (step: () => Promise<void> | void): Promise<void> => {
    try {
      await step();
    } catch (error) {
      steps.report(error);
    }
  };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    source.on(signal, () => {
      if (handled) return;
      handled = true;
      void (async () => {
        await attempt(steps.stopChildren);
        await attempt(steps.restoreSource);
        await attempt(steps.rebuild);
        steps.exit(code);
      })();
    });
  }
}

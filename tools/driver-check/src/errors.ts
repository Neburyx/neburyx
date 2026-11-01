/** An experiment failed; carries the cleanup problems found before it did, so they are not lost. */
export class ExperimentError extends Error {
  constructor(
    cause: unknown,
    readonly cleanupFailures: readonly string[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

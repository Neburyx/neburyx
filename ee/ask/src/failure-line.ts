import type { ProviderFailure } from './anthropic.js';

export const PROVIDER_FAILURE_EVENT = 'ai.provider_failure';

const WARN_LEVEL = 40;

/** Writes one line in the API's log shape to the process output; the line is built from the fixed fields of the record, so nothing else can enter it. */
export function writeFailureLine(failure: ProviderFailure): void {
  const line = {
    level: WARN_LEVEL,
    time: Date.now(),
    event: PROVIDER_FAILURE_EVENT,
    code: failure.code,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.errorType === undefined ? {} : { errorType: failure.errorType }),
    msg: 'a model call failed',
  };
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    // A line that cannot be written never changes the answer.
  }
}

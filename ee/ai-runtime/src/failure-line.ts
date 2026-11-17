import type { ExtensionLogger } from '@neburyx/contracts';
import type { ProviderFailure } from './anthropic.js';

const PROVIDER_FAILURE_EVENT = 'ai.provider_failure';

/** Reports a failure to the logger the API handed over, as one warning built from the fixed fields of the record, so nothing else can enter it; with no logger, or a logger that throws, nothing happens and the answer is unchanged. */
export function createFailureReporter(currentLogger: () => ExtensionLogger | undefined): (failure: ProviderFailure) => void {
  return (failure) => {
    try {
      currentLogger()?.warn(
        {
          event: PROVIDER_FAILURE_EVENT,
          code: failure.code,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          ...(failure.errorType === undefined ? {} : { errorType: failure.errorType }),
        },
        'a model call failed',
      );
    } catch {
      // A line that cannot be written never changes the answer.
    }
  };
}

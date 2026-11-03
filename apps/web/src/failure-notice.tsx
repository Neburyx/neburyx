import type { ApiFailure } from './api/client.js';

export function FailureNotice({ failure }: { readonly failure: ApiFailure }) {
  return (
    <p role="alert">
      {failure.code}
      {'traceId' in failure ? ` · trace ${failure.traceId}` : ''}
    </p>
  );
}

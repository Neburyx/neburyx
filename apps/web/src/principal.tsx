import { useCallback } from 'react';
import type { ApiClient } from './api/client.js';
import { useRequest } from './api/use-request.js';
import { FailureNotice } from './failure-notice.js';

export function Principal({ client }: { readonly client: ApiClient }) {
  const load = useCallback((signal: AbortSignal) => client.getMe(signal), [client]);
  const { state } = useRequest(load);

  const me = state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
  if (state.phase === 'failed') return <FailureNotice failure={state.failure} />;
  if (me === undefined) return <p role="status">Loading</p>;
  return (
    <>
      <p>
        {me.principal.displayName} · {me.edition}
      </p>
      {state.phase === 'ready' && state.failure !== undefined ? <FailureNotice failure={state.failure} /> : null}
    </>
  );
}

import { useCallback, useState, type ReactNode } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { useRequest } from '../api/use-request.js';
import { FailureNotice } from '../failure-notice.js';

function ProfileSummary({ client, sourceId, actions }: { readonly client: ApiClient; readonly sourceId: string; readonly actions?: ((profile: SourceProfile) => ReactNode) | undefined }) {
  const load = useCallback((signal: AbortSignal) => client.getProfile(sourceId, signal), [client, sourceId]);
  const { state } = useRequest(load);
  const profile = state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
  const failure = state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
  return (
    <section aria-label={`Profile of ${sourceId}`}>
      {failure === undefined ? null : <FailureNotice failure={failure} />}
      {profile === undefined ? (
        failure === undefined ? <p role="status">Loading the profile</p> : null
      ) : (
        <>
          <p>
            {profile.entityTypes.length} entity types · {profile.relationshipTypes.length} relationship types
          </p>
          <ul>
            {profile.entityTypes.map((entityType) => (
              <li key={entityType.type}>{entityType.label}</li>
            ))}
          </ul>
          {actions?.(profile)}
        </>
      )}
    </section>
  );
}

export function SourcesPanel({ client, actions }: { readonly client: ApiClient; readonly actions?: (profile: SourceProfile) => ReactNode }) {
  const load = useCallback((signal: AbortSignal) => client.getSources(signal), [client]);
  const { state } = useRequest(load);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const sources = state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;

  if (state.phase === 'failed') return <FailureNotice failure={state.failure} />;
  const retained = state.phase === 'ready' ? state.failure : undefined;
  if (sources === undefined) return <p role="status">Loading the sources</p>;
  const notice = retained === undefined ? null : <FailureNotice failure={retained} />;
  if (sources.items.length === 0) {
    return (
      <>
        {notice}
        <p>No sources are configured.</p>
      </>
    );
  }
  return (
    <>
      {notice}
      <ul aria-label="Sources">
        {sources.items.map((source) => (
          <li key={source.id}>
            <button type="button" aria-pressed={chosen === source.id} onClick={() => setChosen(source.id)}>
              {source.alias}
            </button>{' '}
            <span>{source.state}</span>
            {source.stateReason === null ? null : <span> · {source.stateReason}</span>}
            {source.synthetic ? <span> · synthetic</span> : null}
          </li>
        ))}
      </ul>
      {chosen === undefined ? null : <ProfileSummary key={chosen} client={client} sourceId={chosen} actions={actions} />}
    </>
  );
}

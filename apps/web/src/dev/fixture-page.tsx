import { useCallback, useState } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { useRequest } from '../api/use-request.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { FixtureError } from './fixture-graph.js';
import { loadFixture } from './fixture-loader.js';
import { FailureNotice } from '../failure-notice.js';
import { SourcesPanel } from './sources-panel.js';

const SEED = 1;

function LoadFixture({ client, profile }: { readonly client: ApiClient; readonly profile: SourceProfile }) {
  const state = useClientState();
  const graph = useLoadedGraph();
  const pinned = useStoreSelector(state.presentation.view, (current) => current.pins.size);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const load = useCallback((signal: AbortSignal) => client.getMe(signal), [client]);
  const me = useRequest(load).state;
  const principalId = me.phase === 'ready' || me.phase === 'loading' ? me.data?.principal.id : undefined;
  const meFailure = me.phase === 'failed' || me.phase === 'ready' ? me.failure : undefined;

  const onLoad = (): void => {
    if (principalId === undefined) return;
    try {
      loadFixture(state, profile, principalId, SEED);
      setRefusal(undefined);
    } catch (error) {
      if (!(error instanceof FixtureError)) throw error;
      setRefusal(error.code);
    }
  };

  return (
    <div>
      <button type="button" onClick={onLoad} disabled={principalId === undefined}>
        Load
      </button>
      {meFailure === undefined ? null : <FailureNotice failure={meFailure} />}
      {refusal === undefined ? null : <p role="alert">{refusal}</p>}
      <p>
        {graph.entities.value} entities · {graph.relationships.value} relationships · loaded · exact
      </p>
      <p>{pinned} pinned</p>
    </div>
  );
}

export function FixturePage({ client }: { readonly client: ApiClient }) {
  return (
    <section data-dev-tool="neburyx-dev-fixture-route">
      <h2>Fixture graph</h2>
      <SourcesPanel client={client} actions={(profile) => <LoadFixture client={client} profile={profile} />} />
    </section>
  );
}

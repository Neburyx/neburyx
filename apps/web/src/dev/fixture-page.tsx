import { useState } from 'react';
import { Link } from 'react-router';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { FixtureError } from './fixture-graph.js';
import { loadFixture } from './fixture-loader.js';
import { FailureNotice } from '../failure-notice.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useSlots } from '../workspace/slots.js';
import { registerStandIns } from './stand-ins.js';
import { SourcesPanel } from './sources-panel.js';

const SEED = 1;

function LoadFixture({ profile }: { readonly profile: SourceProfile }) {
  const state = useClientState();
  const slots = useSlots();
  const graph = useLoadedGraph();
  const pinned = useStoreSelector(state.presentation.view, (current) => current.pins.size);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const { me } = useShellData();
  const principalId = answeredData(me)?.principal.id;
  const meFailure = retainedFailure(me);

  const onLoad = (): void => {
    if (principalId === undefined) return;
    try {
      loadFixture(state, profile, principalId, SEED);
      registerStandIns(slots);
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
      {graph.entities.value === 0 ? null : <Link to={EXPLORE_PATH}>Open Explore</Link>}
    </div>
  );
}

export function FixturePage({ client }: { readonly client: ApiClient }) {
  return (
    <section data-dev-tool="neburyx-dev-fixture-route">
      <PageHeading title="Fixture graph" description="Development only: loads a generated graph into the page state." />
      <SourcesPanel client={client} actions={(profile) => <LoadFixture profile={profile} />} />
    </section>
  );
}

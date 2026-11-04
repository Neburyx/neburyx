import { useState } from 'react';
import { Link } from 'react-router';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { useClientState, useLoadedGraph } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { FixtureError } from './fixture-graph.js';
import { loadFixture, type LoaderOptions } from './fixture-loader.js';
import { FailureNotice } from '../failure-notice.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useSelectionActionRegistry } from '../workspace/selection-actions.js';
import { useSlots } from '../workspace/slots.js';
import { useMenuRegistry } from '../workspace/menu-registry.js';
import { useToolRegistry } from '../workspace/tool-registry.js';
import { registerStandInActions, registerStandInMenuItems, registerStandInTools, registerStandIns } from './stand-ins.js';
import { SourcesPanel } from './sources-panel.js';

const SEED = 1;
const LEFT_OUT_ENTITIES = 2;

function LoadFixture({ profile }: { readonly profile: SourceProfile }) {
  const state = useClientState();
  const slots = useSlots();
  const actions = useSelectionActionRegistry();
  const tools = useToolRegistry();
  const menus = useMenuRegistry();
  const graph = useLoadedGraph();
  const pinned = useStoreSelector(state.presentation.view, (current) => current.pins.size);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const { me } = useShellData();
  const principalId = answeredData(me)?.principal.id;
  const meFailure = retainedFailure(me);

  const onLoad = (options?: LoaderOptions): void => {
    if (principalId === undefined) return;
    try {
      loadFixture(state, profile, principalId, SEED, options);
      registerStandIns(slots);
      registerStandInActions(actions);
      registerStandInTools(tools);
      registerStandInMenuItems(menus);
      setRefusal(undefined);
    } catch (error) {
      if (!(error instanceof FixtureError)) throw error;
      setRefusal(error.code);
    }
  };

  return (
    <div>
      <button type="button" onClick={() => onLoad()} disabled={principalId === undefined}>
        Load
      </button>
      <button type="button" onClick={() => onLoad({ withoutEntities: LEFT_OUT_ENTITIES })} disabled={principalId === undefined}>
        Load with entities left out
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

import type { SourceProfile } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey } from '../state/keys.js';
import { generateFixtureGraph } from './fixture-graph.js';

export const LOADER_MARKER = 'neburyx-dev-fixture-loader';

/** Fills the client state from a profile: records to server state, refs to investigation state, pins to presentation state. A refused profile changes nothing. */
export function loadFixture(state: ClientState, profile: SourceProfile, principalId: string, seed: number): void {
  const graph = generateFixtureGraph(profile, seed);
  const key = { sourceId: profile.sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: `${LOADER_MARKER}:seed=${seed}` };
  state.bindSource(profile.sourceId);
  state.putResult(key, { sourceId: profile.sourceId, nodes: graph.nodes, edges: graph.edges });
  state.setLoaded([key], graph.nodes.map((node) => node.ref), graph.edges.map((edge) => edge.ref));
  state.replacePins(graph.pins.map(elementKey));
}

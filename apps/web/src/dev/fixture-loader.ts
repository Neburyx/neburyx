import type { SourceProfile } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import type { InvestigationRecord } from '../state/investigation-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey } from '../state/keys.js';
import { generateFixtureGraph } from './fixture-graph.js';

export const LOADER_MARKER = 'neburyx-dev-fixture-loader';

/** Synthetic: made-up investigation details so the header has something to show before any real investigation exists. */
export const FIXTURE_RECORD: InvestigationRecord = { title: 'Suspicious linked accounts', caseRef: 'REF-2026-1048', save: { kind: 'saved', at: '2026-10-28T09:42:00Z' } };

export interface LoaderOptions {
  /** How many connected entities are left out of the loaded refs, so the relationships that join them are loaded but cannot be drawn. */
  readonly withoutEntities?: number;
}

/** Fills the client state from a profile: records to server state, refs and a synthetic investigation record to investigation state, pins to presentation state. A refused profile changes nothing. */
export function loadFixture(state: ClientState, profile: SourceProfile, principalId: string, seed: number, options: LoaderOptions = {}): void {
  const graph = generateFixtureGraph(profile, seed);
  const connected = new Set(graph.edges.flatMap((edge) => [elementKey(edge.from), elementKey(edge.to)]));
  const left = new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((id) => connected.has(id)).slice(0, options.withoutEntities ?? 0));
  const key = { sourceId: profile.sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: `${LOADER_MARKER}:seed=${seed}` };
  state.bindSource(profile.sourceId);
  state.putResult(key, { sourceId: profile.sourceId, nodes: graph.nodes, edges: graph.edges });
  state.setLoaded([key], graph.nodes.map((node) => node.ref).filter((ref) => !left.has(elementKey(ref))), graph.edges.map((edge) => edge.ref));
  state.replacePins(graph.pins.map(elementKey).filter((id) => !left.has(id)));
  state.describeInvestigation(FIXTURE_RECORD);
}

import { COVERAGE_SCOPE } from '@neburyx/contracts';
import type { ApiClient } from './client.js';

const UNREACHABLE = async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) as const;

const NOT_RETRIEVED_UNKNOWN = async () => ({ ok: true, value: { notRetrieved: { quality: 'unknown', scope: COVERAGE_SCOPE } } }) as const;

/** A client whose reads fail as unreachable unless a test supplies them. */
export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return { getMe: UNREACHABLE, getSources: UNREACHABLE, getProfile: UNREACHABLE, testSource: UNREACHABLE, getEntity: UNREACHABLE, getEdge: UNREACHABLE, lookupEntity: UNREACHABLE, openInvestigation: UNREACHABLE, getInvestigation: UNREACHABLE, saveDraft: UNREACHABLE, deleteInvestigation: UNREACHABLE, restoreInvestigation: UNREACHABLE, deleteView: UNREACHABLE, saveView: UNREACHABLE, listViews: UNREACHABLE, restoreView: UNREACHABLE, renameView: UNREACHABLE, changeInvestigationStatus: UNREACHABLE, renameInvestigation: UNREACHABLE, readRefs: UNREACHABLE, listInvestigations: UNREACHABLE, listInvestigationPage: UNREACHABLE, listOwnedViews: UNREACHABLE, searchEntities: UNREACHABLE, searchMore: UNREACHABLE, previewExpansion: UNREACHABLE, graphCoverage: NOT_RETRIEVED_UNKNOWN, derivedNeighbors: UNREACHABLE, expandNeighbors: UNREACHABLE, ...overrides };
}

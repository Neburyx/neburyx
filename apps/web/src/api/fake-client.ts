import type { ApiClient } from './client.js';

const UNREACHABLE = async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) as const;

/** A client whose reads fail as unreachable unless a test supplies them. */
export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return { getMe: UNREACHABLE, getSources: UNREACHABLE, getProfile: UNREACHABLE, testSource: UNREACHABLE, getEntity: UNREACHABLE, lookupEntity: UNREACHABLE, openInvestigation: UNREACHABLE, getInvestigation: UNREACHABLE, listInvestigations: UNREACHABLE, searchEntities: UNREACHABLE, previewExpansion: UNREACHABLE, expandNeighbors: UNREACHABLE, ...overrides };
}

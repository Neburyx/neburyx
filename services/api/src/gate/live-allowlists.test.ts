import { describe, expect, it } from 'vitest';
import { createLiveMapping } from '../mapping/live.js';
import { baseSource, fileOf, load } from '../testing/mapping.js';
import { parseMapping } from '../mapping/load.js';
import { liveAllowlists } from './live-allowlists.js';

describe('the allowlists of a live mapping', () => {
  it('follow the mapping when it is replaced: a new entity type is allowed, a removed one is not, a removed source has none', () => {
    const live = createLiveMapping(load(baseSource()));
    const allowlists = liveAllowlists(live);
    expect(allowlists.get('demo')?.entityLabels.has('node_c')).toBe(false);
    expect(allowlists.get('missing')).toBeUndefined();
    live.replace(parseMapping(fileOf(baseSource({ entities: [{ type: 'node_a', label: 'NodeA', stable_id: 'id' }, { type: 'node_c', label: 'NodeC', stable_id: 'ref' }], relationships: [] })), 'next.yaml'));
    expect(allowlists.get('demo')?.entityLabels.has('node_c')).toBe(true);
    expect(allowlists.get('demo')?.entityLabels.has('node_b')).toBe(false);
    live.replace({ sources: [] });
    expect(allowlists.get('demo')).toBeUndefined();
  });

  it('makes one allowlist for a source and keeps it while its configHash is the same', () => {
    const live = createLiveMapping(load(baseSource()));
    const allowlists = liveAllowlists(live);
    expect(allowlists.get('demo')).toBe(allowlists.get('demo'));
    const before = allowlists.get('demo');
    live.replace(load(baseSource()));
    expect(allowlists.get('demo')).toBe(before);
  });
});

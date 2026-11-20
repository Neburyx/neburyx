import { describe, expect, it } from 'vitest';
import { buildContext } from './context.js';
import type { AssistantContextTurn } from './thread-store.js';

const turn = (over: Partial<AssistantContextTurn>): AssistantContextTurn => ({ route: 'ask', outcome: 'answered', intent: 'shared', entities: [], citationRefs: [], ...over });
const read = () => Promise.resolve({ nodes: [], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact' as const, scope: 'coverage' }, uncounted: 0 });

describe('the context of the router', () => {
  it('shows a turn that waited for a confirmation as waiting, with nothing read for it and no element it ran for', async () => {
    const context = await buildContext({ turns: [turn({ outcome: 'waiting', entities: [{ role: 'id', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } }] })], sourceId: 'demo', read });
    expect(context?.text).toContain("ask \"shared\"; waiting for the analyst's confirmation, nothing was read for it");
    expect(context?.text).not.toContain('answered');
    expect(context?.text).not.toContain('ran for');
  });
});

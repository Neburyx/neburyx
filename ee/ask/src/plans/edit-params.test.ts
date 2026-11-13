import { describe, expect, it } from 'vitest';
import { editedParams } from './edit-params.js';

const SOURCE = 'demo';
const ref = (stableId = 'a-1', sourceId: unknown = SOURCE) => ({ sourceId, entityType: 'node_a', stableId });

describe('the parameters of an edit that are refused', () => {
  it.each([
    ['a reference of another source', 'entity' as const, { ref: ref('a-1', 'elsewhere') }, 'other-source'],
    ['one end of a derived edge of another source', 'derived-edge-support' as const, { ruleId: 'r', ends: [ref(), ref('a-2', 'elsewhere')] }, 'other-source'],
    ['a reference that names no source', 'entity' as const, { ref: { entityType: 'node_a', stableId: 'a-1' } }, 'invalid'],
    ['a source that is not text', 'entity' as const, { ref: ref('a-1', 7) }, 'invalid'],
    ['a reference that is not an object', 'entity' as const, { ref: 'a-1' }, 'invalid'],
    ['no reference', 'entity' as const, {}, 'invalid'],
    ['a field the template does not name', 'entity' as const, { ref: ref(), query: 'MATCH (n) RETURN n' }, 'invalid'],
    ['a field of another template', 'entity' as const, { ref: ref(), neighborTypes: ['node_b'] }, 'invalid'],
    ['a derived edge with ends that are not a pair', 'derived-edge-support' as const, { ruleId: 'r', ends: [ref()] }, 'invalid'],
    ['a derived edge with no ends', 'derived-edge-support' as const, { ruleId: 'r' }, 'invalid'],
    ['a search with no text', 'search' as const, { entityTypes: ['node_a'] }, 'invalid'],
    ['a limit below one', 'expand' as const, { ref: ref(), neighborTypes: ['node_b'], limit: 0 }, 'invalid'],
  ])('refuses %s', (_name, templateId, params, status) => {
    expect(editedParams(templateId, params, SOURCE)).toEqual({ status });
  });
});

describe('the parameters of an edit that are taken', () => {
  it('drops the source of a reference of the plan’s own source, and keeps the rest', () => {
    expect(editedParams('expand', { ref: ref('a-2'), neighborTypes: ['node_b'], limit: 5 }, SOURCE)).toEqual({ status: 'ok', params: { ref: { entityType: 'node_a', stableId: 'a-2' }, neighborTypes: ['node_b'], limit: 5 } });
  });

  it('takes both ends of a derived edge', () => {
    expect(editedParams('derived-edge-support', { ruleId: 'r', ends: [ref('a-1'), ref('a-2')] }, SOURCE)).toEqual({ status: 'ok', params: { ruleId: 'r', ends: [{ entityType: 'node_a', stableId: 'a-1' }, { entityType: 'node_a', stableId: 'a-2' }] } });
  });

  it('takes a search, which holds no reference, with the text it names', () => {
    expect(editedParams('search', { entityTypes: ['node_a'], text: 'ref 77' }, SOURCE)).toEqual({ status: 'ok', params: { entityTypes: ['node_a'], text: 'ref 77' } });
  });
});

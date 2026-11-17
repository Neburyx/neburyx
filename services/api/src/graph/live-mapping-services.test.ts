import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { SourceAccess } from '../investigations/source-access.js';
import { createLiveMapping } from '../mapping/live.js';
import { parseMapping } from '../mapping/load.js';
import { createPatternRunService } from '../patterns/run-service.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { createDerivedNeighborsService } from './derived-neighbors-service.js';
import { createExpandService } from './expand-service.js';
import { createPathsService } from './paths-service.js';
import { createTemplateRunService } from './template-run-service.js';

const MARKER = new Error('reached the gate');
const gate = { run: () => Promise.reject(MARKER), runMany: () => Promise.reject(MARKER), fileQuery: () => Promise.reject(MARKER) };
const access = { require: () => Promise.resolve(), admit: () => undefined, readable: () => Promise.resolve([]) } as unknown as SourceAccess;
const entities = { read: () => Promise.reject(MARKER), readMany: () => Promise.reject(MARKER) } as never;
const PRINCIPAL = { id: 'p', displayName: 'P', role: 'administrator' } as never;
const before = () => parseMapping(fileOf(baseSource()), 'before.yaml');
const after = () => parseMapping(fileOf(baseSource({ entities: [...(baseSource()['entities'] as object[]), { type: 'node_c', label: 'NodeC', stable_id: 'ref' }] }), baseSource({ id: 'second' })), 'after.yaml');

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'none';
  } catch (error) {
    return error instanceof AppError ? error.code : error === MARKER ? 'gate' : `other:${String(error)}`;
  }
}

describe('the read services that hold a live mapping', () => {
  it('follow a replaced mapping: an entity type or a source the edit added is accepted by the service and reaches the gate, and before the edit it is refused', async () => {
    const live = createLiveMapping(before());
    const common = { gate, mapping: live, access } as never;
    const expand = createExpandService({ ...(common as object), entities } as never);
    const derived = createDerivedNeighborsService({ ...(common as object), entities } as never);
    const paths = createPathsService(common);
    const templates = createTemplateRunService(common);
    const patterns = createPatternRunService(common);
    const call = (sourceId: string, entityType: string) => ({
      expand: () => expand.expand({ traceId: 't', principal: PRINCIPAL, sourceId, entityType, stableId: 'x', neighborTypes: ['node_b'], direction: 'both' } as never),
      derived: () => derived.derive({ traceId: 't', principal: PRINCIPAL, sourceId, entityType, stableId: 'x', mask: false } as never),
      paths: () => paths.find({ traceId: 't', principal: PRINCIPAL, sourceId, from: { entityType, stableId: 'a' }, to: { entityType, stableId: 'b' }, relTypes: [], maxHops: 2, limit: 5, mask: false } as never),
      templates: () => templates.run({ traceId: 't', principal: PRINCIPAL, sourceId, id: 'shared-attribute', params: {}, mask: false } as never),
      patterns: () => patterns.run({ traceId: 't', principal: PRINCIPAL, sourceId, definition: { anchorType: entityType, steps: [] }, anchor: { entityType, stableId: 'a' }, mask: false } as never),
    });

    const names = ['expand', 'derived', 'paths', 'templates', 'patterns'] as const;
    const codes = async (sourceId: string, entityType: string) => Object.fromEntries(await Promise.all(names.map(async (name) => [name, await codeOf(call(sourceId, entityType)[name])])));

    // before the edit: the source it adds is not held, so all five refuse a read of it, and so do the two that check the entity type
    expect(await codes('second', 'node_a')).toEqual({ expand: 'INVALID_REQUEST', derived: 'NOT_FOUND', paths: 'NOT_FOUND', templates: 'NOT_FOUND', patterns: 'NOT_FOUND' });
    expect(await codeOf(call('demo', 'node_c').derived)).toBe('NOT_FOUND');

    live.replace(after());

    // after it: the allowlist checks pass. Expand and paths go on to the gate; derived (a source with no derived rule answers an empty list) and the entity type the edit added are accepted;
    // the template run and the pattern run go on to refuse the bare request for its own reasons, not as an unknown source
    expect(await codes('second', 'node_a')).toEqual({ expand: 'gate', derived: 'none', paths: 'gate', templates: 'INVALID_REQUEST', patterns: 'INVALID_REQUEST' });
    expect(await codeOf(call('demo', 'node_c').derived)).toBe('none');

    // an edit that removes an entity type: the services that check the type refuse it again, with no restart
    live.replace(parseMapping(fileOf(baseSource({ entities: [{ type: 'node_b', label: 'NodeB', stable_id: 'key' }], relationships: [] }), baseSource({ id: 'second', entities: [{ type: 'node_b', label: 'NodeB', stable_id: 'key' }], relationships: [] })), 'removed.yaml'));
    expect(await codeOf(call('second', 'node_a').expand)).toBe('INVALID_REQUEST');
    expect(await codeOf(call('second', 'node_a').derived)).toBe('NOT_FOUND');
    expect(await codeOf(call('demo', 'node_a').derived)).toBe('NOT_FOUND');
  });
});

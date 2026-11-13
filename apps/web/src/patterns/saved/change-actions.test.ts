import { PATTERN_LIMITS, type SavedPattern } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../api/fake-client.js';
import type { ApiResult } from '../../api/client.js';
import { failure, listed } from '../patterns-kit.js';
import { copyName, saveAsCopy, saveChanges } from './change-actions.js';

const DEFINITION = { anchorType: 'kind-a', steps: [{ relationshipTypes: ['link-a'], direction: 'out' as const, arrivesAt: 'kind-b' }] };
const MOVED = { anchorType: 'kind-b', steps: [{ relationshipTypes: ['link-a'], direction: 'in' as const, arrivesAt: 'kind-a' }] };
const STORED = {} as SavedPattern;
const item = (overrides: Record<string, unknown> = {}) => listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Alpha', version: 4, definition: DEFINITION, ...overrides });

describe('the change of a saved pattern from its run view', () => {
  it('sends the definition and the version alone while the start type and the choice to ask are as stored', async () => {
    const sent: unknown[] = [];
    const client = fakeClient({ changePattern: async (_id, request) => (sent.push(request), { ok: true, value: STORED }) });
    await saveChanges(client, item({ askForStartingEntity: false }), DEFINITION as never, { entityType: 'kind-a', stableId: 'acc-9' }, undefined);
    expect(sent[0]).toEqual({ expectedVersion: 4, definition: DEFINITION });
  });

  it('sends the entity now chosen when the start type changed and the pattern held its entity, and clears it when none is chosen', async () => {
    const sent: unknown[] = [];
    const client = fakeClient({ changePattern: async (_id, request) => (sent.push(request), { ok: true, value: STORED }) });
    const held = item({ askForStartingEntity: false, anchor: { entityType: 'kind-a', stableId: 'acc-1' } });
    await saveChanges(client, held, MOVED as never, { entityType: 'kind-b', stableId: 'dev-1' }, undefined);
    await saveChanges(client, held, MOVED as never, undefined, undefined);
    expect(sent[0]).toMatchObject({ anchor: { entityType: 'kind-b', stableId: 'dev-1' } });
    expect(sent[1]).toMatchObject({ anchor: null });
  });
});

describe('the copy of an edited pattern', () => {
  it('names the copies "(copy)", "(copy 2)" and so on, within the limit of a name', () => {
    expect(copyName('Alpha', 1)).toBe('Alpha (copy)');
    expect(copyName('Alpha', 2)).toBe('Alpha (copy 2)');
    const long = copyName('x'.repeat(PATTERN_LIMITS.nameLength), 3);
    expect(Array.from(long)).toHaveLength(PATTERN_LIMITS.nameLength);
    expect(long.endsWith(' (copy 3)')).toBe(true);
  });

  it('trims the end of the cut part, so that a cut after a space leaves no double space', () => {
    const name = `${'x'.repeat(PATTERN_LIMITS.nameLength - ' (copy)'.length - 1)} yyyy`;
    expect(copyName(name, 1)).toBe(`${'x'.repeat(PATTERN_LIMITS.nameLength - ' (copy)'.length - 1)} (copy)`);
    expect(copyName(name, 1)).not.toContain('  ');
  });

  it('goes to the next name while the name is used, stops on any other refusal, and holds the entity only for a pattern that holds its start', async () => {
    const names: string[] = [];
    let answers: Array<ApiResult<SavedPattern>> = [{ ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) }, { ok: false, failure: failure('ACCESS_DENIED') }];
    const requests: unknown[] = [];
    const client = fakeClient({
      savePattern: async (request) => {
        requests.push(request);
        names.push(request.kind === 'definition' ? request.name : '');
        return answers.shift() ?? { ok: true, value: STORED };
      },
    });
    const result = await saveAsCopy(client, 'a', item({ askForStartingEntity: false }), DEFINITION as never, { entityType: 'kind-a', stableId: 'acc-2' }, undefined);
    expect(names).toEqual(['Alpha (copy)', 'Alpha (copy 2)']);
    expect(result.ok).toBe(false);
    expect(requests[0]).toMatchObject({ anchor: { entityType: 'kind-a', stableId: 'acc-2' } });
    answers = [];
    await saveAsCopy(client, 'a', item({ askForStartingEntity: true }), DEFINITION as never, { entityType: 'kind-a', stableId: 'acc-2' }, undefined);
    expect(requests.at(-1)).not.toHaveProperty('anchor');
  });
});

import { MAX_READ_REFS, askAnswerSchema, type ElementRefs } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { firstMisfit, lookupWrittenValues, valueNotFitAnswer, type LookupInput, type WrittenValue } from './written-values.js';

const TYPES = ['customer', 'account', 'device'];
const node = (entityType: string, stableId: string, title = `${entityType} ${stableId}`) => ({ ref: { sourceId: 'demo', entityType, stableId }, display: { title, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const customer: WrittenValue = { role: 'owner', value: '1:800042CB0', needed: 'customer' };

/** A source that holds the elements named as `type/id`; every other reference is unresolved. `omit` flags the read as having left something out. */
function source(held: readonly string[], omit = false) {
  const reads: ElementRefs[] = [];
  const read: LookupInput['read'] = async (refs) => {
    reads.push(refs);
    return { nodes: refs.entities.filter((ref) => held.includes(`${ref.entityType}/${ref.stableId}`)).map((ref) => node(ref.entityType, ref.stableId)), omitted: omit } as never;
  };
  return { reads, read };
}
const run = (held: readonly string[], values: readonly WrittenValue[] = [customer], over: { omit?: boolean; types?: readonly string[] } = {}) => {
  const s = source(held, over.omit);
  return { s, done: lookupWrittenValues({ sourceId: 'demo', types: over.types ?? TYPES, values, read: s.read }) };
};

describe('what a written value is', () => {
  it('fits when an element of the type the role needs has the id', async () => {
    const { done } = run(['customer/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'fits' });
  });

  it('is another type when only other types have the id, listing every one in the mapping order with the title the gate gave', async () => {
    const { done } = run(['device/1:800042CB0', 'account/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'other-type', found: [expect.objectContaining({ type: 'account', title: 'account 1:800042CB0' }), expect.objectContaining({ type: 'device' })] });
  });

  it('fits when the needed type has it, even if another type has the same id', async () => {
    const { done } = run(['customer/1:800042CB0', 'account/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'fits' });
  });

  it('is none when no type has it and nothing was left out', async () => {
    const { done } = run([]);
    expect((await done)[0]?.verdict).toEqual({ kind: 'none' });
  });

  it('is hidden when no type has it and the read left something out: one hidden value in a read makes an unknown id of the same read hidden, the cautious answer', async () => {
    const values: WrittenValue[] = [customer, { role: 'other', value: 'NOBODY', needed: 'customer' }];
    const { done } = run([], values, { omit: true });
    expect((await done).map((entry) => entry.verdict.kind)).toEqual(['hidden', 'hidden']);
  });

  it('still says another type for a value that was found, whatever else the read left out', async () => {
    const { done } = run(['account/1:800042CB0'], [customer], { omit: true });
    expect((await done)[0]?.verdict.kind).toBe('other-type');
  });

  it('never takes a failed read for an absent element', async () => {
    const failing = lookupWrittenValues({ sourceId: 'demo', types: TYPES, values: [customer], read: () => Promise.reject(new Error('the gate refused')) });
    await expect(failing).rejects.toThrow('the gate refused');
  });
});

describe('the references of the lookup', () => {
  it('are a reference of the needed type and one of each other type for every value, as ids in the elements of one read and nothing else', async () => {
    const { s, done } = run([], [customer, { role: 'b', value: 'X-2', needed: 'account' }]);
    await done;
    expect(s.reads).toHaveLength(1);
    expect(s.reads[0]?.entities.map((ref) => `${ref.entityType}/${ref.stableId}`)).toEqual(['customer/1:800042CB0', 'account/1:800042CB0', 'device/1:800042CB0', 'customer/X-2', 'account/X-2', 'device/X-2']);
    expect([s.reads[0]?.edges, s.reads[0]?.aggregates, s.reads[0]?.derived]).toEqual([[], [], []]);
  });

  it.each([
    [MAX_READ_REFS / 4, 1],
    [MAX_READ_REFS / 4 + 1, 2],
    [(MAX_READ_REFS / 4) * 2 + 1, 3],
  ])('split into reads of at most %s values by 4 types (%s values make %s reads), the references of a value always together', async (count, reads) => {
    const four = ['customer', 'account', 'device', 'merchant'];
    const values = Array.from({ length: count }, (_unused, index) => ({ role: `r${index}`, value: `V-${index}`, needed: 'customer' }));
    const { s, done } = run([], values, { types: four });
    expect(await done).toHaveLength(count);
    expect(s.reads).toHaveLength(reads);
    for (const read of s.reads) {
      expect(read.entities.length).toBeLessThanOrEqual(MAX_READ_REFS);
      for (const id of new Set(read.entities.map((ref) => ref.stableId))) expect(read.entities.filter((ref) => ref.stableId === id)).toHaveLength(four.length);
    }
  });

  it('make no read at all for no value', async () => {
    const { s, done } = run([], []);
    expect(await done).toEqual([]);
    expect(s.reads).toHaveLength(0);
  });
});

describe('the answer for a value that does not fit', () => {
  const answered = async (held: readonly string[], omit = false) => {
    const { done } = run(held, [customer], { omit });
    const misfit = firstMisfit(await done);
    if (misfit === undefined) throw new Error('every value fit');
    return valueNotFitAnswer(misfit, 'shared');
  };

  it('is a refusal of the schema for each kind, with the fixed sentences, the first element found cited with its title for another type, and never "nothing found"', async () => {
    const other = await answered(['account/1:800042CB0']);
    expect(askAnswerSchema.parse(other)).toMatchObject({ refused: { cause: 'value-not-fit', intent: 'shared', sentence: 'account 1:800042CB0 is an account; this question needs a customer. Nothing was run.', valueNotFit: { kind: 'other-type', needed: 'customer', found: 'account', citation: { title: 'account 1:800042CB0', type: 'account' } } } });
    const none = await answered([]);
    expect(askAnswerSchema.parse(none)).toMatchObject({ refused: { sentence: 'There is no customer with that id. Nothing was run.', valueNotFit: { kind: 'not-found', needed: 'customer' } } });
    const hidden = await answered([], true);
    expect(askAnswerSchema.parse(hidden)).toMatchObject({ refused: { sentence: 'That value does not give a customer this question can use. Nothing was run.', valueNotFit: { kind: 'hidden' } } });
  });

  it('is decided by the first value that does not fit, in the order given, and by none when all fit', async () => {
    const { done } = run(['customer/OK'], [{ role: 'a', value: 'OK', needed: 'customer' }, { role: 'b', value: 'NOBODY', needed: 'customer' }, { role: 'c', value: 'NOBODY-TOO', needed: 'customer' }]);
    expect(firstMisfit(await done)).toMatchObject({ role: 'b' });
    const fits = run(['customer/OK']);
    expect(firstMisfit(await run(['customer/OK'], [{ role: 'a', value: 'OK', needed: 'customer' }]).done)).toBeUndefined();
    await fits.done;
  });
});

describe('a canary for the check', () => {
  it('shows the tests above fail without it: a lookup that takes every id for a fit gives no refusal for a wrong-type or an unknown id', async () => {
    const lax = (checked: Awaited<ReturnType<typeof lookupWrittenValues>>) => checked.map((entry) => ({ ...entry, verdict: { kind: 'fits' as const } }));
    for (const held of [['account/1:800042CB0'], []]) {
      const { done } = run(held);
      expect(firstMisfit(await done)).toBeDefined();
      expect(firstMisfit(lax(await run(held).done))).toBeUndefined();
    }
  });
});

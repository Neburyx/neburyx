import { MAX_READ_REFS, askAnswerSchema, type ElementRefs } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { firstMisfit, lookupWrittenValues, valueNotFitAnswer, type LookupInput, type WrittenValue } from './written-values.js';

const TYPES = ['widget', 'gadget', 'gizmo'];
const node = (entityType: string, stableId: string, title = `${entityType} ${stableId}`) => ({ ref: { sourceId: 'demo', entityType, stableId }, display: { title, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const widget: WrittenValue = { role: 'holder', value: '1:800042CB0', needed: 'widget' };

/** A source that holds the elements named as `type/id`; every other reference is unresolved. `omit` flags the read as having left something out. */
function source(held: readonly string[], omit = false) {
  const reads: ElementRefs[] = [];
  const read: LookupInput['read'] = async (refs) => {
    reads.push(refs);
    return { nodes: refs.entities.filter((ref) => held.includes(`${ref.entityType}/${ref.stableId}`)).map((ref) => node(ref.entityType, ref.stableId)), omitted: omit } as never;
  };
  return { reads, read };
}
const run = (held: readonly string[], values: readonly WrittenValue[] = [widget], over: { omit?: boolean; types?: readonly string[] } = {}) => {
  const s = source(held, over.omit);
  return { s, done: lookupWrittenValues({ sourceId: 'demo', types: over.types ?? TYPES, values, read: s.read }) };
};

describe('what a written value is', () => {
  it('fits when an element of the type the role needs has the id', async () => {
    const { done } = run(['widget/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'fits' });
  });

  it('is another type when only other types have the id, listing every one in the mapping order with the title the gate gave', async () => {
    const { done } = run(['gizmo/1:800042CB0', 'gadget/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'other-type', found: [expect.objectContaining({ type: 'gadget', title: 'gadget 1:800042CB0' }), expect.objectContaining({ type: 'gizmo' })] });
  });

  it('fits when the needed type has it, even if another type has the same id', async () => {
    const { done } = run(['widget/1:800042CB0', 'gadget/1:800042CB0']);
    expect((await done)[0]?.verdict).toEqual({ kind: 'fits' });
  });

  it('is none when no type has it and nothing was left out', async () => {
    const { done } = run([]);
    expect((await done)[0]?.verdict).toEqual({ kind: 'none' });
  });

  it('is hidden when no type has it and the read left something out: one hidden value in a read makes an unknown id of the same read hidden, the cautious answer', async () => {
    const values: WrittenValue[] = [widget, { role: 'other', value: 'NOBODY', needed: 'widget' }];
    const { done } = run([], values, { omit: true });
    expect((await done).map((entry) => entry.verdict.kind)).toEqual(['hidden', 'hidden']);
  });

  it('still says another type for a value that was found, whatever else the read left out', async () => {
    const { done } = run(['gadget/1:800042CB0'], [widget], { omit: true });
    expect((await done)[0]?.verdict.kind).toBe('other-type');
  });

  it('never takes a failed read for an absent element', async () => {
    const failing = lookupWrittenValues({ sourceId: 'demo', types: TYPES, values: [widget], read: () => Promise.reject(new Error('the gate refused')) });
    await expect(failing).rejects.toThrow('the gate refused');
  });
});

describe('the references of the lookup', () => {
  it('are a reference of the needed type and one of each other type for every value, as ids in the elements of one read and nothing else', async () => {
    const { s, done } = run([], [widget, { role: 'b', value: 'X-2', needed: 'gadget' }]);
    await done;
    expect(s.reads).toHaveLength(1);
    expect(s.reads[0]?.entities.map((ref) => `${ref.entityType}/${ref.stableId}`)).toEqual(['widget/1:800042CB0', 'gadget/1:800042CB0', 'gizmo/1:800042CB0', 'widget/X-2', 'gadget/X-2', 'gizmo/X-2']);
    expect([s.reads[0]?.edges, s.reads[0]?.aggregates, s.reads[0]?.derived]).toEqual([[], [], []]);
  });

  it.each([
    [MAX_READ_REFS / 4, 1],
    [MAX_READ_REFS / 4 + 1, 2],
    [(MAX_READ_REFS / 4) * 2 + 1, 3],
  ])('split into reads of at most %s values by 4 types (%s values make %s reads), the references of a value always together', async (count, reads) => {
    const four = ['widget', 'gadget', 'gizmo', 'sprocket'];
    const values = Array.from({ length: count }, (_unused, index) => ({ role: `r${index}`, value: `V-${index}`, needed: 'widget' }));
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
    const { done } = run(held, [widget], { omit });
    const misfit = firstMisfit(await done);
    if (misfit === undefined) throw new Error('every value fit');
    return valueNotFitAnswer(misfit, 'shared');
  };

  it('is a refusal of the schema for each kind, with the fixed sentences, the first element found cited with its title for another type, and never "nothing found"', async () => {
    const other = await answered(['gadget/1:800042CB0']);
    expect(askAnswerSchema.parse(other)).toMatchObject({ refused: { cause: 'value-not-fit', intent: 'shared', sentence: 'gadget 1:800042CB0 is a gadget; this question needs a widget. Nothing was run.', valueNotFit: { kind: 'other-type', needed: 'widget', found: 'gadget', citation: { title: 'gadget 1:800042CB0', type: 'gadget' } } } });
    const none = await answered([]);
    expect(askAnswerSchema.parse(none)).toMatchObject({ refused: { sentence: 'There is no widget with that id. Nothing was run.', valueNotFit: { kind: 'not-found', needed: 'widget' } } });
    const hidden = await answered([], true);
    expect(askAnswerSchema.parse(hidden)).toMatchObject({ refused: { sentence: 'That value does not give a widget this question can use. Nothing was run.', valueNotFit: { kind: 'hidden' } } });
  });

  it('is decided by the first value that does not fit, in the order given, and by none when all fit', async () => {
    const { done } = run(['widget/OK'], [{ role: 'a', value: 'OK', needed: 'widget' }, { role: 'b', value: 'NOBODY', needed: 'widget' }, { role: 'c', value: 'NOBODY-TOO', needed: 'widget' }]);
    expect(firstMisfit(await done)).toMatchObject({ role: 'b' });
    const fits = run(['widget/OK']);
    expect(firstMisfit(await run(['widget/OK'], [{ role: 'a', value: 'OK', needed: 'widget' }]).done)).toBeUndefined();
    await fits.done;
  });
});

describe('a canary for the check', () => {
  it('shows the tests above fail without it: a lookup that takes every id for a fit gives no refusal for a wrong-type or an unknown id', async () => {
    const lax = (checked: Awaited<ReturnType<typeof lookupWrittenValues>>) => checked.map((entry) => ({ ...entry, verdict: { kind: 'fits' as const } }));
    for (const held of [['gadget/1:800042CB0'], []]) {
      const { done } = run(held);
      expect(firstMisfit(await done)).toBeDefined();
      expect(firstMisfit(lax(await run(held).done))).toBeUndefined();
    }
  });
});

describe('the sentence of a refusal', () => {
  const longTitle = 'T'.repeat(400);
  const node = (title: string, type: string) => ({ ref: { sourceId: 'demo', entityType: 'gadget', stableId: 'K-1' }, display: { title, type } });

  it('fits what a refusal holds, whatever the title the gate gave: a title of 400 characters is cut at a code point, the sentence stays within the bound and still ends as it should', async () => {
    const reading = { nodes: [node(longTitle, 'gadget')], omitted: false };
    const checked = await lookupWrittenValues({ sourceId: 'demo', types: ['widget', 'gadget'], values: [{ role: 'id', value: 'K-1', needed: 'widget' }], read: async () => reading as never });
    const misfit = firstMisfit(checked);
    if (misfit === undefined) throw new Error('every value fit');
    const answer = valueNotFitAnswer(misfit, 'shared');
    expect(askAnswerSchema.safeParse(answer).success).toBe(true);
    const refused = (answer as { refused: { sentence: string; valueNotFit: { citation: { title: string } } } }).refused;
    expect(refused.sentence.length).toBeLessThanOrEqual(300);
    expect(refused.sentence.endsWith('Nothing was run.')).toBe(true);
    expect(refused.valueNotFit.citation.title.endsWith('…')).toBe(true);
  });

  it('names both types as the mapping names them for a person: the display name of the needed type next to the one of the element found, and a name of any length is cut to what a refusal holds', async () => {
    const reading = { nodes: [node('K-1', 'IP address')], omitted: false };
    const checked = await lookupWrittenValues({ sourceId: 'demo', types: ['ip_address', 'gadget'], values: [{ role: 'id', value: 'K-1', needed: 'ip_address', neededLabel: 'Shop owner account '.repeat(10) }], read: async () => reading as never });
    const misfit = firstMisfit(checked);
    if (misfit === undefined) throw new Error('every value fit');
    const answer = valueNotFitAnswer(misfit, undefined);
    expect(askAnswerSchema.safeParse(answer).success).toBe(true);
    expect((answer as { refused: { valueNotFit: { needed: string } } }).refused.valueNotFit.needed.length).toBeLessThanOrEqual(64);
    const plain = valueNotFitAnswer({ ...misfit, neededLabel: 'Shop owner' }, undefined);
    expect((plain as { refused: { sentence: string } }).refused.sentence).toBe('K-1 is an IP address; this question needs a shop owner. Nothing was run.');
  });
});

describe('a mapping with a keyed type', () => {
  const types = ['widget', 'gadget', 'phone'];
  it('does not send a reference of a keyed type for the other types, and says none, not hidden, for an unknown id', async () => {
    const s = source([]);
    const checked = await lookupWrittenValues({ sourceId: 'demo', types, keyed: new Set(['phone']), values: [{ role: 'id', value: 'NOBODY', needed: 'widget' }], read: s.read });
    expect(checked[0]?.verdict).toEqual({ kind: 'none' });
    expect(s.reads[0]?.entities.map((ref) => ref.entityType)).toEqual(['widget', 'gadget']);
  });

  it('still tells another type apart and still fits', async () => {
    const found = await lookupWrittenValues({ sourceId: 'demo', types, keyed: new Set(['phone']), values: [{ role: 'id', value: 'K-1', needed: 'widget' }], read: source(['gadget/K-1']).read });
    expect(found[0]?.verdict.kind).toBe('other-type');
    const fits = await lookupWrittenValues({ sourceId: 'demo', types, keyed: new Set(['phone']), values: [{ role: 'id', value: 'W-1', needed: 'widget' }], read: source(['widget/W-1']).read });
    expect(fits[0]?.verdict.kind).toBe('fits');
  });

  it('is hidden, with no read for it, when the type the role needs is itself keyed: a typed value cannot stand for such an identifier', async () => {
    const s = source([]);
    const checked = await lookupWrittenValues({ sourceId: 'demo', types, keyed: new Set(['phone']), values: [{ role: 'number', value: '+1 555 0100', needed: 'phone' }, { role: 'id', value: 'W-1', needed: 'widget' }], read: s.read });
    expect(checked.map((entry) => entry.verdict.kind)).toEqual(['hidden', 'none']);
    expect(s.reads).toHaveLength(1);
    expect(JSON.stringify(s.reads)).not.toContain('555');
  });
});

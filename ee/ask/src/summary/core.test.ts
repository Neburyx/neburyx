import type { ElementRef } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { SummaryBuilder, citedKeysExist, listOf, type Listed } from './core.js';
import { countWords, groupedNumber, remainderSentence } from './counts.js';
import { addNamed } from './shared.js';
import { nodeTitle, refId } from './title.js';

const ref = (stableId: string): ElementRef => ({ sourceId: 'demo', entityType: 'node_a', stableId });
const item = (stableId: string, title = stableId): Listed => ({ element: ref(stableId), type: 'node_a', title });
const many = (count: number) => listOf(Array.from({ length: count }, (_, index) => item(`e${index}`)));

describe('the summary builder', () => {
  it('cannot build a sentence with no element, or with an element the result does not list', () => {
    const builder = new SummaryBuilder(many(2));
    expect(() => builder.add('x', [])).toThrow(/at least one/);
    expect(() => builder.add('x', [ref('skipped')])).toThrow(/does not list/);
  });

  it('closes a sentence with one full stop when the title before it ends with one, and leaves an ellipsis alone', () => {
    const builder = new SummaryBuilder(many(3));
    builder.add('It is Rivenisica Components Ltd..', [ref('e0')]);
    builder.add('It is Wait...', [ref('e1')]);
    builder.add('Plain.', [ref('e2')]);
    expect(builder.finish()?.sentences.map((sentence) => sentence.text)).toEqual(['It is Rivenisica Components Ltd.', 'It is Wait...', 'Plain.']);
  });

  it('gives keys in the order of first citation, and the same key to the same element', () => {
    const builder = new SummaryBuilder(many(3));
    builder.add('first', [ref('e2')]);
    builder.add('second', [ref('e0'), ref('e2')]);
    const summary = builder.finish();
    expect(summary?.sentences).toEqual([{ text: 'first', cites: ['n1'] }, { text: 'second', cites: ['n2', 'n1'] }]);
    expect(summary?.citations.map((citation) => [citation.key, citation.title])).toEqual([['n1', 'e2'], ['n2', 'e0']]);
  });

  it('gives no summary when nothing was built, and the same summary for the same result twice', () => {
    expect(new SummaryBuilder(many(1)).finish()).toBeUndefined();
    const build = () => {
      const builder = new SummaryBuilder(many(2));
      builder.add('a', [ref('e0')]);
      builder.add('b', [ref('e1')]);
      return builder.finish('omitted.');
    };
    expect(build()).toEqual(build());
  });

  it('keeps the sentences that fit when there are too many, never cuts one, and says how many were left out with the citations only they would have made left out too', () => {
    const builder = new SummaryBuilder(many(20));
    for (let index = 0; index < 15; index += 1) builder.add(`sentence ${index}`, [ref(`e${index}`)]);
    const summary = builder.finish();
    expect(summary?.sentences).toHaveLength(12);
    expect(summary?.citations).toHaveLength(12);
    expect(summary?.omissions).toBe('3 statements were left out.');
  });

  it('leaves out a sentence of more than 300 characters whole, and one that would pass 40 citations', () => {
    const builder = new SummaryBuilder(many(50));
    builder.add('x'.repeat(301), [ref('e0')]);
    builder.add('fits', [ref('e1')]);
    expect(builder.finish()?.omissions).toBe('1 statement was left out.');
    const wide = new SummaryBuilder(many(50));
    wide.add('a', Array.from({ length: 40 }, (_, index) => ref(`e${index}`)));
    wide.add('b', [ref('e45')]);
    const summary = wide.finish();
    expect(summary?.citations).toHaveLength(40);
    expect(summary?.omissions).toBe('1 statement was left out.');
  });

  it('joins the omissions line of the builder with the count of statements left out', () => {
    const builder = new SummaryBuilder(many(20));
    for (let index = 0; index < 13; index += 1) builder.add(`s${index}`, [ref(`e${index}`)]);
    expect(builder.finish('5 shown.')?.omissions).toBe('5 shown. 1 statement was left out.');
  });
});

describe('the check of cited keys', () => {
  const listed = many(2);
  const built = () => {
    const builder = new SummaryBuilder(listed);
    builder.add('a', [ref('e0')]);
    const summary = builder.finish();
    if (summary === undefined) throw new Error('no summary');
    return summary;
  };

  it('is true for a summary the builder made', () => {
    expect(citedKeysExist(built(), listed)).toBe(true);
  });

  it('is false for a sentence with no key, a key no citation holds, or a citation for an element the result does not list', () => {
    const summary = built();
    expect(citedKeysExist({ ...summary, sentences: [{ text: 'a', cites: [] }] }, listed)).toBe(false);
    expect(citedKeysExist({ ...summary, sentences: [{ text: 'a', cites: ['n9'] }] }, listed)).toBe(false);
    expect(citedKeysExist({ ...summary, citations: summary.citations.map((citation) => ({ ...citation, element: ref('elsewhere') })) }, listed)).toBe(false);
  });
});

describe('the title of a node', () => {
  const node = (title: string) => ({ ref: ref('a-1'), display: { title, type: 'node_a' }, properties: [{ key: 'secret', value: 'MASKED-VALUE', dataClass: 'text' as const, masked: true }], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });

  it('is the title as the result has it, or the stable ID when the title is empty, and never a property value', () => {
    expect(nodeTitle(node('Alice'))).toBe('Alice');
    expect(nodeTitle(node(''))).toBe('a-1');
    expect(nodeTitle(node('  '))).toBe('a-1');
    expect(nodeTitle(node(''))).not.toContain('MASKED');
  });

  it('gives one id to equal references whatever the order of their fields', () => {
    expect(refId({ stableId: 'x', sourceId: 's', entityType: 't' })).toBe(refId({ sourceId: 's', entityType: 't', stableId: 'x' }));
  });
});

describe('the words of counts', () => {
  it('writes each quality as the application does, and no digit for a count that has none', () => {
    expect(countWords({ quality: 'exact', value: 1234, scope: 's' })).toBe('1,234 · exact');
    expect(countWords({ quality: 'estimated', value: 1500000, scope: 's' })).toBe('~ 1,500,000 (estimated)');
    expect(countWords({ quality: 'lowerBound', value: 50, scope: 's' })).toBe('≥ 50 · lower bound');
    expect(countWords({ quality: 'unknown', scope: 's' })).toBe('no count');
    expect(groupedNumber(999)).toBe('999');
    expect(groupedNumber(1000)).toBe('1,000');
  });

  it('writes what is not yet retrieved with the quality of the total', () => {
    expect(remainderSentence({ quality: 'exact', value: 12, scope: 's' }, 5)).toBe('5 shown; 7 · exact not yet retrieved.');
    expect(remainderSentence({ quality: 'estimated', value: 12, scope: 's' }, 5)).toBe('5 shown; ~ 7 (estimated) not yet retrieved.');
    expect(remainderSentence({ quality: 'lowerBound', value: 12, scope: 's' }, 5)).toBe('5 shown; ≥ 7 · lower bound not yet retrieved.');
    expect(remainderSentence({ quality: 'unknown', scope: 's' }, 5)).toBe('5 shown; how many are not yet retrieved is not known.');
    expect(remainderSentence(undefined, 5)).toBe('5 shown.');
  });
});

describe('a sentence that lists names', () => {
  const names = (count: number): { title: string; ref: ElementRef }[] => Array.from({ length: count }, (_, index) => ({ title: `${'n'.repeat(70)}${index}`, ref: ref(`e${index}`) }));

  it('is tried with fewer names, always as a part of the list, before the length limit leaves it out, and the retry is not counted as left out', () => {
    const builder = new SummaryBuilder(many(5));
    addNamed(builder, (list, _count, whole) => (whole ? `${list} are all.` : `Some are ${list}.`), names(5), true);
    const summary = builder.finish();
    expect(summary?.sentences).toHaveLength(1);
    expect(summary?.sentences[0]?.text.startsWith('Some are ')).toBe(true);
    expect(summary?.sentences[0]?.cites).toHaveLength(3);
    expect(summary?.omissions).toBeUndefined();
  });

  it('is left out only when the shortest sentence is still too long', () => {
    const builder = new SummaryBuilder(many(1));
    addNamed(builder, (list) => `Some are ${list}.`, [{ title: 'x'.repeat(400), ref: ref('e0') }], true);
    expect(builder.finish()).toBeUndefined();
  });

  it('adds nothing for no names', () => {
    const builder = new SummaryBuilder(many(1));
    addNamed(builder, (list) => list, [], true);
    expect(builder.finish()).toBeUndefined();
  });
});

describe('the words of counts, against the table the web app reads too', () => {
  it('writes every case of the shared table as the table says', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const table = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/contracts/fixtures/count-words.json', import.meta.url)), 'utf8')) as { cases: { count: Parameters<typeof countWords>[0]; words: string }[] };
    expect(table.cases.length).toBeGreaterThan(5);
    for (const { count, words } of table.cases) expect(countWords(count)).toBe(words);
  });
});

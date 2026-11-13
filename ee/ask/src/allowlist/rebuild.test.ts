import { describe, expect, it } from 'vitest';
import { AllowlistInputError, rebuildWithWords, type ResolvedSpan } from './rebuild.js';

const COMMON = ['which', 'use', 'the', 'same', 'as', 'show', 'me', 'and', 'in', 'what', 's'];
const VOCABULARY = ['Widget', 'Gadget', 'spare_part'];

function run(text: string, spans: readonly ResolvedSpan[] = [], vocabulary: readonly string[] = VOCABULARY, commonWords: readonly string[] = COMMON) {
  return rebuildWithWords({ text, spans, vocabulary }, commonWords);
}

const blockedTexts = (text: string, spans: readonly ResolvedSpan[] = []): readonly string[] => {
  const result = run(text, spans);
  return result.kind === 'blocked' ? result.tokens.map((token) => token.text) : [];
};

describe('a question that holds a token that is not allowed', () => {
  it('blocks an unknown word with its text and its position, and builds nothing', () => {
    const result = run('show me the zebra widget');
    expect(result).toEqual({ kind: 'blocked', tokens: [{ text: 'zebra', start: 12, end: 17 }] });
    expect(result).not.toHaveProperty('text');
  });

  it('blocks a digit run of four digits or more, and lets three digits through', () => {
    expect(blockedTexts('show me 2025 widgets')).toEqual(['2025']);
    expect(blockedTexts('show me 12345 widgets')).toEqual(['12345']);
    expect(run('show me 999 widgets')).toEqual({ kind: 'rebuilt', text: 'show me 999 widgets' });
  });

  it('blocks every number of a run of numbers and a compound that holds a number', () => {
    expect(blockedTexts('show me 10 000 widgets')).toEqual(['10', '000']);
    expect(blockedTexts('show me 555 123 456')).toEqual(['555', '123', '456']);
    expect(blockedTexts('show me 12-34-56')).toEqual(['12-34-56']);
    expect(blockedTexts('show me 555 . 123 . 456')).toEqual(['555', '123', '456']);
    expect(blockedTexts('show me 10 , 000')).toEqual(['10', '000']);
    expect(blockedTexts('show me 555 ? 123')).toEqual(['555', '123']);
    expect(blockedTexts('show me 123-456-789')).toEqual(['123-456-789']);
    expect(blockedTexts('show me 1_000_000')).toEqual(['1_000_000']);
  });

  it('blocks an email address as one token, first to last character', () => {
    const result = run('show me a.b@example.test now');
    expect(result).toEqual({ kind: 'blocked', tokens: [{ text: 'a.b@example.test', start: 8, end: 24 }, { text: 'now', start: 25, end: 28 }] });
  });

  it('blocks a made-up lowercase surname', () => {
    expect(blockedTexts('which widget did zorvath use')).toEqual(['did', 'zorvath']);
  });

  it('blocks typed text that looks like a placeholder, and a placeholder with other characters attached', () => {
    expect(blockedTexts('show me ‹widget#1›')).toEqual(['‹widget#1›']);
    const text = 'show me Acme\'s widget';
    const span = { start: 8, end: 12, placeholder: '‹widget#1›' };
    expect(blockedTexts(text, [span])).toEqual(["Acme's"]);
    expect(blockedTexts('show me (Acme) widget', [{ start: 9, end: 13, placeholder: '‹widget#1›' }])).toEqual(['(Acme)']);
  });

  it('blocks symbols, leading quotes and brackets, and a word with an apostrophe', () => {
    expect(blockedTexts('show { me')).toEqual(['{']);
    expect(blockedTexts('show ` me')).toEqual(['`']);
    expect(blockedTexts('show < me')).toEqual(['<']);
    expect(blockedTexts('show "widget" me')).toEqual(['"widget"']);
    expect(blockedTexts('show (widget) me')).toEqual(['(widget)']);
    expect(blockedTexts("what's the widget")).toEqual(["what's"]);
  });

  it('blocks a token that holds a character outside ASCII', () => {
    for (const word of ['Key', 'İp', 'ａｃｃｏｕｎｔ', 'acc١', 'acc​ount']) expect(blockedTexts(`show me ${word}`)).toEqual([word]);
    expect(blockedTexts('show me')).toEqual(['show me']);
  });

  it('returns every blocked token in the order typed, at the right position after an emoji', () => {
    const result = run('😀 show zorvath me qwx');
    expect(result).toEqual({
      kind: 'blocked',
      tokens: [
        { text: '😀', start: 0, end: 2 },
        { text: 'zorvath', start: 8, end: 15 },
        { text: 'qwx', start: 19, end: 22 },
      ],
    });
  });

  it('gives positions in the typed text after a span whose placeholder has another length', () => {
    const text = 'Acme Corp zorvath';
    const result = run(text, [{ start: 0, end: 9, placeholder: '‹widget#1›' }]);
    expect(result).toEqual({ kind: 'blocked', tokens: [{ text: 'zorvath', start: 10, end: 17 }] });
  });

  it('throws for spans that overlap, lie outside the text, are empty or have a placeholder of the wrong form', () => {
    const ok = '‹widget#1›';
    expect(() => run('abcdef', [{ start: 0, end: 4, placeholder: ok }, { start: 3, end: 5, placeholder: '‹widget#2›' }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: 1, end: 9, placeholder: ok }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: -1, end: 2, placeholder: ok }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: 2, end: 2, placeholder: ok }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: 0, end: 2, placeholder: 'widget' }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: 0, end: 2, placeholder: '‹widget#0›' }])).toThrow(AllowlistInputError);
    expect(() => run('abc', [{ start: 0, end: 2, placeholder: '‹Acme Corp#1›' }])).toThrow(AllowlistInputError);
  });

  it('throws for an empty question and a question of whitespace only', () => {
    expect(() => run('')).toThrow('empty');
    expect(() => run(' \t\r\n ')).toThrow('empty');
  });
});

describe('a question made only of allowed tokens', () => {
  it('is rebuilt with each span replaced, whitespace collapsed, edges trimmed and the typed case kept', () => {
    const text = '  Which   widgets use the same GADGET as Acme   Corp ?  ';
    const start = text.indexOf('Acme');
    const result = run(text, [{ start, end: start + 'Acme   Corp'.length, placeholder: '‹widget#1›' }]);
    expect(result).toEqual({ kind: 'rebuilt', text: 'Which widgets use the same GADGET as ‹widget#1› ?' });
  });

  it('keeps the marks after a token, a run of marks and a token that is only marks', () => {
    expect(run('which widget?!')).toEqual({ kind: 'rebuilt', text: 'which widget?!' });
    expect(run('which widget...')).toEqual({ kind: 'rebuilt', text: 'which widget...' });
    expect(run('which widget ; the same:')).toEqual({ kind: 'rebuilt', text: 'which widget ; the same:' });
  });

  it('allows a placeholder followed by a mark and a compound of allowed words', () => {
    expect(run('which use Acme?', [{ start: 10, end: 14, placeholder: '‹widget#1›' }])).toEqual({ kind: 'rebuilt', text: 'which use ‹widget#1›?' });
    expect(run('show me the spare_part and the spare-part')).toEqual({ kind: 'rebuilt', text: 'show me the spare_part and the spare-part' });
  });
});

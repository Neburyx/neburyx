import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IRREGULAR_VERB_LIST, formsOf, vocabularyForms } from './forms.js';
import { rebuildWithWords } from './rebuild.js';

const MAX_FORMS = 15;
const SURNAME_FORMS = ['began', 'begin', 'begun', 'bring', 'brought', 'buy', 'came', 'come', 'drew', 'found', 'gave', 'given', 'go', 'gone', 'held', 'hold', 'keep', 'know', 'left', 'lose', 'met', 'pay', 'ran', 'run', 'saw', 'see', 'seen', 'sell', 'send', 'tell', 'went', 'write'];

const COMMON = ['which', 'the', 'of'];

function blocked(text: string, vocabulary: readonly string[], commonWords: readonly string[] = COMMON): readonly string[] {
  const result = rebuildWithWords({ text, spans: [], vocabulary }, commonWords);
  return result.kind === 'blocked' ? result.tokens.map((token) => token.text) : [];
}

describe('the forms of a vocabulary word', () => {
  it('allows plural and verb forms of the vocabulary words', () => {
    const vocabulary = ['use', 'transfer', 'connect', 'repair', 'gadget', 'widget'];
    expect(blocked('uses used transfers transferred connected repaired gadgets widgets', vocabulary)).toEqual([]);
  });

  it('allows the parts of a PascalCase label and of an upper-snake relationship type', () => {
    expect(blocked('spare part parts spare_parts holds widget', ['SparePart', 'HOLDS_WIDGET'])).toEqual([]);
  });

  it('counts a word as vocabulary only when the vocabulary carries it', () => {
    expect(blocked('gadget gadgets', ['widget'])).toEqual(['gadget', 'gadgets']);
    expect(blocked('gadget gadgets', ['widget', 'Gadget'])).toEqual([]);
  });

  it('blocks a word that only looks like a form of a vocabulary word', () => {
    expect(blocked('widgetant widgetable unwidget widgetss', ['widget'])).toEqual(['widgetant', 'widgetable', 'unwidget', 'widgetss']);
    expect(blocked('repairred', ['repair'])).toEqual(['repairred']);
    expect(blocked('showwing', ['show'])).toEqual(['showwing']);
  });

  it('allows the y, e and doubled-consonant forms', () => {
    expect(blocked('copies copied baking stopped stopping', ['copy', 'bake', 'stop'])).toEqual([]);
  });

  it('does not give a common word a plural it does not list', () => {
    expect(blocked('ofs', [])).toEqual(['ofs']);
  });

  it('allows the capitals of a form and keeps them in the rebuilt text', () => {
    expect(rebuildWithWords({ text: 'WIDGETS', spans: [], vocabulary: ['widget'] }, [])).toEqual({ kind: 'rebuilt', text: 'WIDGETS' });
  });

  it('drops a part of an entry that holds a digit or a non-ASCII character, keeps the others, and does not throw', () => {
    const vocabulary = ['Port6Widget', 'Café'];
    expect(blocked('widget', vocabulary)).toEqual([]);
    expect(blocked('port6 café caf', vocabulary)).toEqual(['port6', 'café', 'caf']);
  });
});

const allowed = (words: string, vocabulary: readonly string[]): boolean => blocked(words, vocabulary).length === 0;

describe('the base of a vocabulary word', () => {
  it.each([
    ['paid', 'pay pays paying'],
    ['lives', 'live lived living'],
    ['involves', 'involve involved involving'],
    ['repaired', 'repair repairing'],
    ['filed', 'file'],
    ['initiated', 'initiate'],
    ['created', 'create'],
    ['used', 'use'],
    ['charging', 'charge'],
    ['caused', 'cause'],
    ['released', 'release'],
    ['leased', 'lease'],
    ['required', 'require'],
    ['agreed', 'agree'],
    ['issued', 'issue'],
    ['continued', 'continue'],
    ['opened', 'open'],
    ['belonging', 'belong'],
    ['bringing', 'bring'],
    ['changing', 'change'],
    ['floated', 'float'],
    ['treated', 'treat'],
    ['repeated', 'repeat'],
    ['echoed', 'echo'],
    ['agreeing', 'agree'],
    ['seeing', 'see'],
    ['carried', 'carry'],
    ['studied', 'study'],
    ['stopped', 'stop'],
    ['transferred', 'transfer'],
    ['reached', 'reach'],
  ])('allows %s as the base of what the vocabulary holds: %s', (held, typed) => {
    expect(blocked(typed, [held])).toEqual([]);
  });

  it('keeps the plain-s base of zes and ches plurals, drops it for xes, shes and oes, and names the toes limit', () => {
    expect(blocked('authorize size cache ache', ['authorizes', 'sizes', 'caches', 'aches'])).toEqual([]);
    expect(blocked('boxe wishe toe shoe', ['boxes', 'wishes', 'toes', 'shoes'])).toEqual(['boxe', 'wishe', 'toe', 'shoe']);
  });

  it('keeps the plain-s base of a short `ies` plural, and blocks goe and doe from goes and does', () => {
    expect(blocked('tie lie die', ['ties', 'lies', 'dies'])).toEqual([]);
    expect(blocked('carry study', ['carries', 'studies'])).toEqual([]);
    expect(blocked('goe doe', ['goes', 'does'])).toEqual(['goe', 'doe']);
  });

  it('allows the irregular forms of a listed verb through a vocabulary word that holds one of its forms', () => {
    expect(blocked('paid sent held bought', ['pay', 'send', 'hold', 'buy'])).toEqual([]);
    expect(blocked('sell selling give giving', ['sold', 'given'])).toEqual([]);
  });

  it.each([
    ['locked', 'locke'],
    ['parking', 'parke'],
    ['parking', 'parkes'],
    ['calling', 'calle'],
    ['calling', 'cal'],
    ['cooked', 'cooke'],
    ['repaired', 'repaire'],
    ['carried', 'carrie'],
    ['married', 'marrie'],
    ['studied', 'studie'],
    ['copied', 'copie'],
    ['going', 'goe'],
    ['carries', 'carrie'],
    ['marries', 'marrie'],
    ['studies', 'studie'],
    ['floated', 'floate'],
    ['agreeing', 'agreee'],
  ])('blocks %s -> %s, which only the stem could make', (held, typed) => {
    expect(blocked(typed, [held])).toEqual([typed]);
  });

  it('blocks the bare stem of a short stem, which is a surname or a name more often than a word: nam, fil, tim, lin, dat and bas', () => {
    expect(blocked('nam fil tim lin dat bas chang rang', ['named', 'filed', 'timed', 'lined', 'dated', 'based', 'changing', 'ranging'])).toEqual(['nam', 'fil', 'tim', 'lin', 'dat', 'bas', 'chang', 'rang']);
    expect(blocked('name file time line date base change range bring sing belong', ['named', 'filed', 'timed', 'lined', 'dated', 'based', 'changing', 'ranging', 'bringing', 'singing', 'belonging'])).toEqual([]);
    expect(blocked('open limit visit edit', ['opened', 'limited', 'visited', 'edited'])).toEqual([]);
  });

  it('keeps the stated limits: the rule is ambiguous in these cases and gives what it gives', () => {
    expect(allowed('limite', ['limited'])).toBe(true);
    // an accepted limit: no structural rule separates change and range from hang and bang
    expect(blocked('hang bang', ['hanging', 'banging'])).toEqual(['hang', 'bang']);
    expect(blocked('hange bange', ['hanging', 'banging'])).toEqual([]);
    expect(allowed('limit', ['limited'])).toBe(true);
    expect(allowed('biase', ['biased'])).toBe(true);
    expect(allowed('bias', ['biased'])).toBe(false);
    expect(allowed('conquere', ['conquered'])).toBe(true);
    expect(allowed('conquer', ['conquered'])).toBe(false);
    expect(allowed('ski', ['skiing'])).toBe(false);
  });

  it('adds `es` only after s, x, z, ch, sh or o, and `d` only after e', () => {
    expect(blocked('parkes parkd', ['park'])).toEqual(['parkes', 'parkd']);
    expect(blocked('presses boxes buzzes churches wishes echoes', ['press', 'box', 'buzz', 'church', 'wish', 'echo'])).toEqual([]);
  });

  it('keeps the earlier negatives', () => {
    expect(blocked('repairred repairable', ['repair'])).toEqual(['repairred', 'repairable']);
    expect(blocked('widgetant widgetable unwidget widgetss', ['widget'])).toEqual(['widgetant', 'widgetable', 'unwidget', 'widgetss']);
  });

  it('is one step: a base found from a form is not reversed again', () => {
    expect(allowed('living livings', ['livings'])).toBe(true);
    expect(blocked('live lived', ['livings'])).toEqual(['live', 'lived']);
  });

  it('opens a vocabulary part to few forms, irregular forms included', () => {
    for (const part of ['passed', 'stopped', 'copied', 'processes', 'involving', 'paid', 'filed', 'caused', 'issued']) {
      expect(vocabularyForms([part]).size, part).toBeLessThanOrEqual(MAX_FORMS);
    }
  });
});

describe('the closed list of irregular verbs', () => {
  it('holds exactly these 25 verbs, sorted by base, each a base with its listed forms and no form twice', () => {
    expect(IRREGULAR_VERB_LIST.map(([base]) => base)).toEqual(['begin', 'bring', 'build', 'buy', 'come', 'draw', 'find', 'give', 'go', 'hold', 'keep', 'know', 'leave', 'lose', 'meet', 'pay', 'run', 'see', 'sell', 'send', 'spend', 'take', 'tell', 'withdraw', 'write']);
    const forms = IRREGULAR_VERB_LIST.flat();
    expect(new Set(forms).size).toBe(forms.length);
    for (const verb of IRREGULAR_VERB_LIST) expect(verb.length).toBeGreaterThanOrEqual(2);
  });

  it('names its forms that are surnames of the public list: they count only through a vocabulary word, never on their own', () => {
    const names = new Set(readFileSync(fileURLToPath(new URL('../testing/names/census-2010-surnames.txt', import.meta.url)), 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line !== ''));
    const surnameForms = IRREGULAR_VERB_LIST.flat().filter((form) => names.has(form)).sort();
    expect(surnameForms).toEqual(SURNAME_FORMS);
    for (const form of surnameForms) expect(blocked(form, ['widget'])).toEqual([form]);
  });
});

/**
 * The verb of each relationship word of the two packs, with the base a question may type. Parts that are the packs' own entity types or labels, and the
 * prepositions, are left out: a noun is typed as the mapping holds it and a preposition is a function word. A verb of a pack without a row fails the test.
 */
const PACK_BASES: Readonly<Record<string, string>> = {
  connects: 'connect', filed: 'file', holds: 'hold', initiated: 'initiate', involves: 'involve', lives: 'live', paid: 'pay',
  reached: 'reach', repaired: 'repair', transferred: 'transfer', uses: 'use',
};

function packTypes(file: string): { readonly relationships: string[]; readonly nouns: ReadonlySet<string> } {
  const text = readFileSync(fileURLToPath(new URL(`../../../../domain-packs/${file}/neburyx.yaml`, import.meta.url)), 'utf8');
  const at = text.indexOf('relationships:');
  const relationships = [...text.slice(at).matchAll(/^\s*- type: ([A-Z][A-Z_]+)\s*$/gm)].map((match) => match[1] ?? '');
  const nouns = new Set([...text.slice(0, at).matchAll(/^\s*- type: ([a-z_]+)\s*$/gm)].flatMap((match) => (match[1] ?? '').split('_')));
  return { relationships, nouns };
}

const CENSUS = fileURLToPath(new URL('../testing/names/census-2010-surnames.txt', import.meta.url));

describe('the reverse forms of the packs and surnames', () => {
  it.each(['banking-fraud', 'insurance-claims'])('%s: a reverse form that is a surname of the public list is a form of the true base of a verb in the table', (pack) => {
    const names = new Set(readFileSync(CENSUS, 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()));
    const { relationships, nouns } = packTypes(pack);
    for (const type of relationships) {
      const forward = new Set(type.toLowerCase().split('_').flatMap((part) => formsOf(part)));
      const trueForms = new Set(type.toLowerCase().split('_').flatMap((part) => (PACK_BASES[part] === undefined ? [] : [...vocabularyForms([PACK_BASES[part] ?? ''])])));
      for (const form of vocabularyForms([type])) {
        if (forward.has(form) || !names.has(form)) continue;
        expect(trueForms.has(form), `${type}: ${form} is a surname and not a form of the true base`).toBe(true);
      }
    }
    expect(nouns.size).toBeGreaterThan(0);
  });
});

const FUNCTION_PARTS = new Set(['from', 'by', 'at', 'to', 'under']);

describe('the relationship words of the packs', () => {
  it.each(['banking-fraud', 'insurance-claims'])('%s: every verb of a relationship word has its base in the table, and the base is allowed', (pack) => {
    const { relationships, nouns } = packTypes(pack);
    expect(relationships.length).toBeGreaterThan(3);
    for (const type of relationships) {
      for (const part of type.toLowerCase().split('_')) {
        if (FUNCTION_PARTS.has(part) || nouns.has(part)) continue;
        const base = PACK_BASES[part];
        expect(base, `${type}: ${part} has no base in the test`).toBeDefined();
        expect(blocked(base ?? '', [type]), `${type}: ${part} -> ${base}`).toEqual([]);
      }
    }
  });
});

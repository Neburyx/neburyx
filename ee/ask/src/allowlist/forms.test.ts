import { describe, expect, it } from 'vitest';
import { rebuildPlannerText } from './rebuild.js';

const COMMON = ['which', 'the', 'of'];

function blocked(text: string, vocabulary: readonly string[], commonWords: readonly string[] = COMMON): readonly string[] {
  const result = rebuildPlannerText({ text, spans: [], vocabulary, commonWords });
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
    expect(rebuildPlannerText({ text: 'WIDGETS', spans: [], vocabulary: ['widget'], commonWords: [] })).toEqual({ kind: 'rebuilt', text: 'WIDGETS' });
  });

  it('drops a part of an entry that holds a digit or a non-ASCII character, keeps the others, and does not throw', () => {
    const vocabulary = ['Port6Widget', 'Café'];
    expect(blocked('widget', vocabulary)).toEqual([]);
    expect(blocked('port6 café caf', vocabulary)).toEqual(['port6', 'café', 'caf']);
  });
});

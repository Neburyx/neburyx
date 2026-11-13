import { describe, expect, it } from 'vitest';
import { rebuildPlannerText } from '../allowlist/index.js';
import { questionVocabulary } from './vocabulary.js';

const view = {
  types: [
    { name: 'Widget', kind: 'entity' as const, properties: [{ name: 'sprocketTag', pii: false }] },
    { name: 'HOLDS_GADGET', kind: 'relationship' as const, properties: [] },
  ],
};

const blocked = (text: string, vocabulary: readonly string[]): readonly string[] => {
  const result = rebuildPlannerText({ text, spans: [], vocabulary });
  return result.kind === 'blocked' ? result.tokens.map((token) => token.text) : [];
};

describe('the question vocabulary', () => {
  it('holds only the contract words when the view has no types', () => {
    const vocabulary = questionVocabulary({ view: { types: [] } });
    expect(vocabulary).toContain('shared-attribute');
    expect(vocabulary).toContain('maxHops');
    expect(questionVocabulary({ view: undefined })).toEqual(vocabulary);
    expect(blocked('widget', vocabulary)).toEqual(['widget']);
  });

  it('holds the type names and no property name', () => {
    const vocabulary = questionVocabulary({ view });
    expect(vocabulary).toContain('Widget');
    expect(vocabulary).toContain('HOLDS_GADGET');
    expect(vocabulary).not.toContain('sprocketTag');
    expect(blocked('widgets holds gadget', vocabulary)).toEqual([]);
    expect(blocked('sprocket tag', vocabulary)).toEqual(['sprocket', 'tag']);
  });

  it('holds the template identifiers and the parameter names of the plan schemas, split into words by the rebuild', () => {
    const vocabulary = questionVocabulary({ view: undefined });
    expect(vocabulary).toEqual(expect.arrayContaining(['shared-attribute', 'linked-entities', 'attributeType', 'targetType', 'direction', 'minShared']));
    expect(blocked('shared attribute linked entities attribute type target type direction hops', vocabulary)).toEqual([]);
  });

  it('adds the catalog words a caller passes and nothing else', () => {
    const vocabulary = questionVocabulary({ view: undefined, catalogWords: ['sprocket'] });
    expect(vocabulary).toContain('sprocket');
    expect(vocabulary.length).toBe(questionVocabulary({ view: undefined }).length + 1);
  });
});

describe('the words of the widened plan contract', () => {
  it('holds the identifiers and parameter names of every template a plan can name, and none of the fields a plan cannot hold', () => {
    const entries = questionVocabulary({ view: undefined });
    for (const entry of ['entity', 'degree-preview', 'expand', 'derived-rule-run', 'derived-edge-support', 'search', 'neighborTypes', 'ruleId', 'ends', 'entityTypes', 'relTypes']) expect(entries).toContain(entry);
    for (const excluded of ['filters', 'rank', 'cursors', 'mask', 'sourceId', 'typeahead']) expect(entries).not.toContain(excluded);
  });
});

import { ASK_PLAN_TEMPLATE_IDS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { CATALOG, catalogText, catalogWords } from './catalog.js';
import { vocabularyText } from './vocabulary-text.js';

describe('the catalog of the planner', () => {
  it('holds each of the eight templates once, with its version, a description and the JSON Schema of its plan parameters', () => {
    expect(CATALOG.map((entry) => entry.id)).toEqual([...ASK_PLAN_TEMPLATE_IDS]);
    for (const entry of CATALOG) {
      expect(entry.version).toBe(1);
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.paramsSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('carries the rules of the question sets in neutral words: the plain question and the chain, a direct relationship and a path through a middle type, a stated direction', () => {
    const text = (id: string) => CATALOG.find((entry) => entry.id === id)?.description ?? '';
    expect(text('shared-attribute')).toContain('plain question');
    expect(text('shared-attribute')).toContain('derived-rule-run');
    expect(text('derived-rule-run')).toContain('chain');
    expect(text('linked-entities')).toContain('one relationship type joins them directly');
    expect(text('linked-entities')).toContain('the entity type that a path goes through');
    expect(text('linked-entities')).toContain('maxHops to 2');
    expect(text('expand')).toContain('Always state the direction');
  });

  it('writes each template as a block with its identifier, version, description and parameters', () => {
    const text = catalogText();
    for (const entry of CATALOG) expect(text).toContain(`${entry.id} (version ${entry.version})`);
    expect(text).toContain('Parameters: {');
  });

  it('gives the words of every description, so the allowlist can accept them', () => {
    const words = catalogWords();
    for (const word of ['Finds', 'anchor', 'relationship', 'direction', 'derived-rule-run']) expect(words).toContain(word);
    expect(words).not.toContain('');
  });
});

describe('the vocabulary of the prompt', () => {
  const view = {
    types: [
      { name: 'node_a', kind: 'entity' as const, properties: [{ name: 'SECRET-PROPERTY', pii: false }] },
      { name: 'node_b', kind: 'entity' as const, properties: [] },
      { name: 'LINKS', kind: 'relationship' as const, properties: [{ name: 'SECRET-WEIGHT', pii: false }], ends: [{ from: 'node_a', to: 'node_b', timed: true }, { from: 'node_a', to: 'node_a', timed: false }] },
    ],
    derivedRules: [{ id: 'shared', from: 'node_a', to: 'node_a' }],
  };

  it('lists the entity types, each relationship type with each pair of ends and whether it has a time, and the rules, by name only', () => {
    const text = vocabularyText(view);
    expect(text).toContain('Entity types: node_a, node_b');
    expect(text).toContain('LINKS: node_a -> node_b, has a time');
    expect(text).toContain('LINKS: node_a -> node_a, has no time');
    expect(text).toContain('shared: node_a -> node_a');
    expect(text).not.toContain('SECRET');
  });

  it('says none for a mapping with no relationship, no rule or no view at all', () => {
    expect(vocabularyText(undefined)).toBe('Entity types: none\nRelationship types:\nnone\nDerived rules:\nnone');
    expect(vocabularyText({ types: [{ name: 'node_a', kind: 'entity', properties: [] }] })).toContain('Relationship types:\nnone');
  });
});

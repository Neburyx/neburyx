import { ASK_PLAN_TEMPLATE_IDS } from '@neburyx/contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMON_WORDS } from '../allowlist/common-words.js';
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

  it('says that a question that asks only for related entities and names no link is answered by no template, in a condition that names no pack word', () => {
    const text = CATALOG.find((entry) => entry.id === 'expand')?.description ?? '';
    expect(text).toContain('asks only for entities related or connected to the anchor, and names no relationship type, derived rule or attribute type, is answered by no template: refuse it');
    expect(text).toContain('Use it when the question asks which entities are directly connected to the anchor.');
  });

  // a weak check on its own: the re-recording of the demo set is the real check that questions naming a link keep their plans
  it('does not catch a question that names a link: the sentence is tied to a question that names none', () => {
    const text = CATALOG.find((entry) => entry.id === 'expand')?.description ?? '';
    expect(text).not.toMatch(/related to .* by /);
    expect(text).toContain('names no relationship type');
  });

  it('says that a path with hops in different directions, whose leading relationship already reaches the target type, is refused, and does not say it of a path through a middle type', () => {
    const text = CATALOG.find((entry) => entry.id === 'linked-entities')?.description ?? '';
    expect(text).toContain('A path whose hops run in different directions, when the relationship type that leads the path already joins the anchor to entities of the target type, is not answered by one run');
    expect(text).toContain("the anchor's own neighbors of the target type would be returned beside the answer. Refuse that question.");
    expect(text).toContain('list every relationship type of the path in via and set maxHops to 2');
  });

  it('says that a question about an individual’s personal details is refused, and that a shared attribute and a quoted value are not that, with no word of any pack', () => {
    const text = CATALOG.find((entry) => entry.id === 'search')?.description ?? '';
    expect(text).toContain('asks for an individual\'s personal details, or that looks an individual up by such a detail, is answered by no template: refuse it');
    expect(text).toContain('A question about which records share an attribute is not this, nor is a value lookup of a reference, other than a personal detail, that the question quotes as a value placeholder.');
  });

  it('adds to the words a question may use only words that are not surnames of the public list, and the surnames it already holds are named', () => {
    const names = new Set(readFileSync(fileURLToPath(new URL('../testing/names/census-2010-surnames.txt', import.meta.url)), 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()));
    const surnameParts = [...new Set(catalogWords().flatMap((word) => word.toLowerCase().split('-')).filter((part) => names.has(part) && !COMMON_WORDS.includes(part)))].sort();
    expect(surnameParts).toEqual(SURNAME_PARTS);
    for (const word of ['answered', 'related', 'refuse']) expect(surnameParts).not.toContain(word);
  });
});

/** The parts of catalog words that are also surnames of the public list: they are ordinary words of the descriptions, and a question may use them. A new word of a description that is one fails the test until it is named here. */
const SURNAME_PARTS = ["anchor","counts","goes","hold","joins","link","list","names","neighbor","neighbors","path","plain","reading","record","records","rule","run","set","share","state","use","way","window"];

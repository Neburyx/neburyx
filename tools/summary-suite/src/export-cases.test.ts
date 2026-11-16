import { renderForExport } from '@neburyx/ee-ask';
import type { ExportSummary } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { loadCases } from './cases.js';
import { defined } from './checks.js';
import { INVESTIGATION } from './testing/rig.js';
import { drafted, hide, withMaskedValues } from './testing/export.js';

const set = loadCases();

const sectionOf = (answer: ReturnType<typeof renderForExport>): ExportSummary => {
  if (answer.status !== 'ok') throw new Error('the export refused the token');
  return answer.section;
};

const namesWhole = (text: string, name: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);

describe('the summary section of an export, for every labelled view', () => {
  it('keeps every drafted sentence for an export of the same reading, labelled, for every labelled view', async () => {
    expect(set.cases).toHaveLength(17);
    for (const labelled of set.cases) {
      const { render, evidence, sentences, outcome } = await drafted(labelled);
      const answer = render(evidence.view);
      const section = sectionOf(answer);
      expect(section.sentences.map((sentence) => sentence.text), labelled.id).toEqual(sentences.map((sentence) => sentence.text));
      expect(section.label).toBe('AI-drafted');
      expect(section.model).toBe(outcome.model);
      expect(new Date(section.generatedAt).toISOString(), labelled.id).toBe(section.generatedAt);
      expect(section.sentences.length).toBeLessThanOrEqual(12);
      const refs = new Set([...evidence.view.nodes.map((node) => JSON.stringify(node.ref)), ...evidence.view.edges.map((edge) => JSON.stringify(edge.ref))]);
      for (const sentence of section.sentences) {
        expect(sentence.cites.length, labelled.id).toBeGreaterThan(0);
        for (const cite of sentence.cites) expect(refs.has(JSON.stringify(cite.ref)), labelled.id).toBe(true);
      }
      expect(answer).toMatchObject({ kept: sentences.length, dropped: 0 });
    }
  });

  it('drops exactly the sentences that cite or name an element the export does not hold, for every labelled view', async () => {
    let dropped = 0;
    for (const labelled of set.cases) {
      const { render, evidence, sentences } = await drafted(labelled);
      const keyOf = (key: string): string => defined(evidence.keys.get(key), `${labelled.id}: the key of ${key}`);
      const counts = new Map<string, number>();
      for (const sentence of labelled.sentences.filter((each) => each.label === 'keep')) for (const key of sentence.cites) counts.set(key, (counts.get(key) ?? 0) + 1);
      const entity = defined(
        labelled.entities.map((each) => ({ each, count: counts.get(each.key) ?? 0 })).sort((a, b) => b.count - a.count)[0]?.each,
        'an entity',
      );
      const touching = new Set(labelled.relationships.filter((relationship) => relationship.from === entity.key || relationship.to === entity.key).map((relationship) => keyOf(relationship.key)));
      const hidden = new Set([keyOf(entity.key), ...touching]);
      const answer = render(hide(evidence.view, entity.id));
      const section = sectionOf(answer);
      const expected = sentences.filter((sentence) => !sentence.cites.some((cite) => hidden.has(cite)) && !namesWhole(sentence.text, entity.name) && !namesWhole(sentence.text, entity.id));
      expect(section.sentences.map((sentence) => sentence.text), labelled.id).toEqual(expected.map((sentence) => sentence.text));
      for (const sentence of section.sentences) expect(namesWhole(sentence.text, entity.name), labelled.id).toBe(false);
      expect(answer, labelled.id).toMatchObject({ kept: expected.length, dropped: sentences.length - expected.length });
      expect(Object.keys(answer).sort(), labelled.id).toEqual(['dropped', 'kept', 'runId', 'section', 'status']);
      dropped += sentences.length - expected.length;
    }
    expect(dropped, 'sentences dropped for a hidden element').toBeGreaterThan(0);
  });

  it('drops the sentences that quote a value the export masks, for every labelled view', async () => {
    let quoting = 0;
    for (const labelled of set.cases) {
      const { render, evidence, sentences } = await drafted(labelled);
      const values = evidence.view.nodes.flatMap((node) => node.properties.map((property) => String(property.value))).filter((value) => value.length > 1);
      const answer = render(withMaskedValues(evidence.view));
      const section = sectionOf(answer);
      for (const sentence of section.sentences) for (const value of values) expect(sentence.text.toLowerCase(), `${labelled.id}: ${value}`).not.toContain(value.toLowerCase());
      for (const sentence of sentences) if (values.some((value) => sentence.text.toLowerCase().includes(value.toLowerCase()))) {
        quoting += 1;
        expect(section.sentences.map((each) => each.text), labelled.id).not.toContain(sentence.text);
      }
    }
    expect(quoting, 'drafted sentences that quote a property value').toBeGreaterThan(0);
  });

  it('gives the same single refusal for an expired token, another person, another investigation, another policy version and an unreadable token', async () => {
    const { render, evidence } = await drafted(defined(set.cases[0], 'the first view'));
    expect(sectionOf(render(evidence.view)).sentences.length).toBeGreaterThan(0);
    const refused = [
      render(evidence.view, { now: Date.now() + 31 * 60 * 1000 }),
      render(evidence.view, { actorId: 'someone-else' }),
      render(evidence.view, { investigationId: INVESTIGATION.replace(/2$/u, '3') }),
      render(evidence.view, { policyVersion: 'policy-2' }),
      render(evidence.view, { token: 'not-a-token' }),
    ];
    for (const answer of refused) expect(answer).toEqual({ status: 'refused' });
  });
});

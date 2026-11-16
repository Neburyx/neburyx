import type { Count, GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { renderForExport } from './export-render.js';
import { sealToken, type SealInput } from './token.js';
import type { TokenKeys } from './token-keys.js';

const KEYS: TokenKeys = { current: { kid: 'cur00001', bytes: Buffer.alloc(32, 1) }, previous: undefined };
const ME = 'person-1';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000c1';
const RUN = '0192f000-0000-7000-8000-0000000000aa';
const ref = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
const W1 = ref('W-1');
const W2 = ref('W-2');
const W3 = ref('W-3');
const node = (r: ReturnType<typeof ref>, title: string): GraphNode => ({ ref: r, display: { title, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const AGG = { sourceId: 'demo', aggregate: { type: 'USES', from: W1, to: W2 } };
const edge = (count: Count | undefined): GraphEdge => ({ ref: AGG, ...(count === undefined ? {} : { memberCount: count }), from: W1, to: W2, type: 'USES', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
const reading = (nodes: GraphNode[], edges: GraphEdge[] = []): SummaryReading => ({ nodes, edges, unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
const ANA = node(W1, 'Ana Silva');
const BO = node(W2, 'Bo Chen');
const CY = node(W3, 'Cy Park');

function sealed(sentences: { text: string; cites: string[] }[], over: Partial<SealInput> = {}): string {
  return sealToken(
    KEYS,
    {
      investigationId: INVESTIGATION,
      generatedBy: ME,
      policyVersion: 'p1',
      modelRef: 'claude-sonnet-5-5',
      promptId: 'case-summary',
      promptVersion: '1',
      sentences,
      inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }, { key: 'n3', kind: 'entity', ref: W3 }, { key: 'e1', kind: 'relationship', ref: AGG }],
      propertyValuesSent: false,
      runId: RUN,
      mask: false,
      wordListVersion: 1,
      templates: sentences.map(() => ({ storable: false as const, reason: 'unlisted-word' as const })),
      ...over,
    },
    Date.now(),
  );
}

const render = (token: string, view: SummaryReading, over: { policyVersion?: string; actorId?: string } = {}) =>
  renderForExport(KEYS, { token, investigationId: INVESTIGATION, actorId: over.actorId ?? ME, policyVersion: over.policyVersion ?? 'p1', reading: view }, Date.now());
const textsOf = (outcome: ReturnType<typeof render>): string[] => (outcome.status === 'ok' ? outcome.section.sentences.map((sentence) => sentence.text) : ['REFUSED']);

describe('the summary section of an export', () => {
  it('keeps a sentence whose cites, names and numbers hold in the export, and labels the section with the model and the two-part coverage', () => {
    const outcome = render(sealed([{ text: 'Ana Silva is linked to Bo Chen.', cites: ['n1', 'n2'] }]), reading([ANA, BO]));
    expect(outcome).toMatchObject({ status: 'ok', runId: RUN, kept: 1, dropped: 0, section: { label: 'AI-drafted', model: 'claude-sonnet-5-5' } });
    if (outcome.status !== 'ok') return;
    expect(outcome.section.coverage).toEqual({ retrieval: '2 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 2 of the 2 shown elements.' });
    expect(outcome.section.sentences[0]?.cites).toEqual([{ kind: 'entity', ref: W1 }, { kind: 'entity', ref: W2 }]);
  });

  it('drops a sentence that cites an element the export does not hold, matching by reference and not by key', () => {
    // the export holds W-2 and W-3 only: its own keys differ from the token's
    expect(textsOf(render(sealed([{ text: 'Ana Silva is listed.', cites: ['n1'] }, { text: 'Bo Chen is listed.', cites: ['n2'] }]), reading([BO, CY])))).toEqual(['Bo Chen is listed.']);
  });

  it('drops a sentence that names an element of the draft the export no longer holds, even one it does not cite, and keeps the control', () => {
    const token = sealed([{ text: 'Bo Chen is linked to Ana Silva.', cites: ['n2'] }, { text: 'Bo Chen is listed.', cites: ['n2'] }]);
    expect(textsOf(render(token, reading([BO])))).toEqual(['Bo Chen is listed.']);
    expect(textsOf(render(token, reading([ANA, BO])))).toEqual(['Bo Chen is linked to Ana Silva.', 'Bo Chen is listed.']);
  });

  it('drops a sentence whose stated count is now not known, or whose number is in none of its cited lines, and keeps the control', () => {
    const exact: Count = { quality: 'exact', value: 48, scope: 's' };
    const token = sealed([{ text: 'The link shows 48 (exact) members.', cites: ['e1'] }]);
    expect(textsOf(render(token, reading([ANA, BO], [edge(exact)])))).toEqual(['The link shows 48 (exact) members.']);
    expect(textsOf(render(token, reading([ANA, BO], [edge({ quality: 'unknown', scope: 's' })])))).toEqual([]);
    expect(textsOf(render(token, reading([ANA, BO], [edge({ quality: 'exact', value: 49, scope: 's' })])))).toEqual([]);
  });

  it('drops a sentence that quotes a value the export reads masked, and keeps it where the value is shown', () => {
    const withTier = (value: string, masked: boolean): GraphNode => ({ ...ANA, properties: [{ key: 'tier', value, dataClass: 'text', masked }] });
    const token = sealed([{ text: 'Ana Silva has tier "gold".', cites: ['n1'] }]);
    expect(textsOf(render(token, reading([withTier('gold', false)])))).toEqual(['Ana Silva has tier "gold".']);
    expect(textsOf(render(token, reading([withTier('g•••', true)])))).toEqual([]);
  });

  it('keeps no sentence of a draft written unmasked when the export masks a property, whatever form of the name the sentence takes or which element it cites, and keeps those of a draft written from the masked view', () => {
    const maskedAna: GraphNode = { ...node(W1, 'A••• S•••'), properties: [{ key: 'name', value: 'A••• S•••', dataClass: 'text', masked: true }] };
    const unmaskedDraft = sealed([{ text: 'ana silva is linked to Bo Chen.', cites: ['n1', 'n2'] }]);
    expect(textsOf(render(unmaskedDraft, reading([ANA, BO])))).toEqual(['ana silva is linked to Bo Chen.']);
    expect(textsOf(render(unmaskedDraft, reading([maskedAna, BO])))).toEqual([]);
    const uncited = sealed([{ text: 'bo chen paid ana silva.', cites: ['n2'] }]);
    expect(textsOf(render(uncited, reading([ANA, BO])))).toEqual(['bo chen paid ana silva.']);
    expect(textsOf(render(uncited, reading([maskedAna, BO])))).toEqual([]);
    const maskedDraft = sealed([{ text: 'A••• S••• is linked to Bo Chen.', cites: ['n1', 'n2'] }], { mask: true });
    expect(textsOf(render(maskedDraft, reading([maskedAna, BO])))).toEqual(['A••• S••• is linked to Bo Chen.']);
  });

  it('returns the section with no sentence and its coverage when every sentence is dropped', () => {
    const outcome = render(sealed([{ text: 'Ana Silva is listed.', cites: ['n1'] }]), reading([BO]));
    expect(outcome).toMatchObject({ status: 'ok', kept: 0, dropped: 1, section: { sentences: [], coverage: { summary: 'No sentence was kept.' } } });
  });

  it('answers the one refusal for a token of another person, another policy version, another investigation or no token at all', () => {
    const token = sealed([{ text: 'Ana Silva is listed.', cites: ['n1'] }]);
    expect(render(token, reading([ANA]), { actorId: 'someone' })).toEqual({ status: 'refused' });
    expect(render(token, reading([ANA]), { policyVersion: 'p2' })).toEqual({ status: 'refused' });
    expect(render('x.y', reading([ANA]))).toEqual({ status: 'refused' });
    expect(renderForExport(KEYS, { token, investigationId: 'another', actorId: ME, policyVersion: 'p1', reading: reading([ANA]) }, Date.now())).toEqual({ status: 'refused' });
  });
});

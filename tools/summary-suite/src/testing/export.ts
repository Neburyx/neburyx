import { renderForExport } from '@neburyx/ee-ask';
import type { SummaryReading } from '@neburyx/contracts';
import { keepersOf, sentenceInKeys, type LabelledCase } from '../cases.js';
import { viewOf } from '../rules.js';
import { INVESTIGATION, KEYS, replyOf, startRig } from './rig.js';

const PERSON = 'analyst-1';
const POLICY = 'policy-1';

/** The draft of the kept sentences of a view, and a way to render its token for an export of any reading. */
export async function drafted(labelled: LabelledCase, masked?: boolean) {
  const evidence = await viewOf(labelled);
  const keep = keepersOf(labelled).map((sentence) => sentenceInKeys(sentence, evidence.keys));
  const rig = startRig({ replies: [replyOf(...keep)], settings: { maxCalls: 1 } });
  const outcome = await rig.summarize(evidence.view, undefined, masked);
  if (outcome.status !== 'ok') throw new Error(`${labelled.id}: the draft was not made (${outcome.status})`);
  const render = (reading: SummaryReading, over: { readonly now?: number; readonly actorId?: string; readonly investigationId?: string; readonly policyVersion?: string; readonly token?: string; readonly render?: typeof renderForExport } = {}) =>
    (over.render ?? renderForExport)(KEYS, { token: over.token ?? outcome.summaryToken, investigationId: over.investigationId ?? INVESTIGATION, actorId: over.actorId ?? PERSON, policyVersion: over.policyVersion ?? POLICY, reading }, over.now ?? Date.now());
  return { labelled, evidence, outcome, render, sentences: outcome.sentences.map(({ text, cites }) => ({ text, cites })) };
}

export const hide = (view: SummaryReading, stableId: string): SummaryReading => ({
  ...view,
  nodes: view.nodes.filter((entity) => entity.ref.stableId !== stableId),
  edges: view.edges.filter((relationship) => relationship.from.stableId !== stableId && relationship.to.stableId !== stableId),
  omitted: true,
});

export const withMaskedValues = (view: SummaryReading): SummaryReading => ({
  ...view,
  nodes: view.nodes.map((entity) => ({ ...entity, properties: entity.properties.map((property) => ({ ...property, value: `${String(property.value).slice(0, 1)}•••`, masked: true })) })),
});


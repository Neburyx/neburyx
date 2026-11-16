import type { SummarySentence } from '@neburyx/contracts';
import { keyMapOf, readingOf, type LabelledCase } from './cases.js';
import { COUNT_TYPES, withEvidence } from './evidence.js';
import { defined, expectCited, expectCountsLabelled, expectNoneOf, expectNoVerdict, expectNumbersCited, keyOfRelationship, keysOfSentText, sentencesOf } from './checks.js';
import { replyOf, startRig } from './testing/rig.js';

const one = { maxCalls: 1 };

/** The rules every kept sentence obeys, stated by the suite itself. */
export function expectClean(sentences: readonly SummarySentence[], sent: string, invented: readonly string[] = []): void {
  expectCited(sentences, keysOfSentText(sent));
  expectNumbersCited(sentences, sent);
  expectCountsLabelled(sentences, sent);
  expectNoVerdict(sentences);
  expectNoneOf(sentences, invented);
}

/** The keys of a view with the evidence added, by the name the rules use. */
export async function viewOf(labelled: LabelledCase) {
  const view = withEvidence(readingOf(labelled));
  const probe = startRig({ replies: [replyOf()], settings: one });
  await probe.summarize(view);
  const sent = defined(probe.requests[0], 'the request').values;
  const keys = keyMapOf(labelled, sent);
  return {
    view,
    sent,
    first: defined(keys.get(defined(labelled.entities[0], 'the first entity').key), 'the first key'),
    second: defined(keys.get(defined(labelled.entities[1], 'the second entity').key), 'the second key'),
    estimated: keyOfRelationship(sent, COUNT_TYPES.estimated),
    lowerBound: keyOfRelationship(sent, COUNT_TYPES.lowerBound),
    unknown: keyOfRelationship(sent, COUNT_TYPES.unknown),
    keys,
  };
}

export type Evidence = Awaited<ReturnType<typeof viewOf>>;

export async function run(labelled: LabelledCase, evidence: Evidence, sentences: readonly SummarySentence[], maxCalls = 1) {
  const rig = startRig({ replies: [replyOf(...sentences)], settings: { maxCalls } });
  const outcome = await rig.summarize(evidence.view);
  return { outcome, rig, sent: evidence.sent, kept: sentencesOf(outcome) };
}


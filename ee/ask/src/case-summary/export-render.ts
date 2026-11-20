import type { CaseSummaryExportInput, CaseSummaryExportOutcome, ExportSummary } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
import { retrievalLine, summaryLine } from './coverage.js';
import { rejudge } from './rejudge.js';
import { openToken } from './token.js';
import type { TokenKeys } from './token-keys.js';

/**
 * The summary section of an export, from the sealed token of a draft and the export's own reading of the elements. The token opens only for this investigation, this person and the policy version in force, or the answer is the
 * one refusal. A sentence is kept only if every element it cites is among the nodes and edges the export holds (matched by reference through the token's inputs, never by key) and it still passes the checks of the draft against
 * the text assembled from the export's own reading: the names and ids it uses belong to that reading, its numbers are in the lines it cites, and a count that is not known drops it; the others are dropped without a message. A draft written unmasked keeps no sentence when the export masks any property, since a sentence may state a masked value in a form the checks cannot see.
 * Reads nothing and takes no charge: the reading is passed in.
 */
export function renderForExport(keys: TokenKeys, input: CaseSummaryExportInput, now: number): CaseSummaryExportOutcome {
  const opened = openToken(keys, input.token, { investigationId: input.investigationId, actorId: input.actorId, policyVersion: input.policyVersion, now });
  if (!opened.ok) return { status: 'refused' };
  const { payload } = opened;
  const { kept, dropped } = rejudge(payload, input.reading);
  const sentences: ExportSummary['sentences'] = kept.map((sentence) => ({ text: sentence.text, cites: [...sentence.refs] }));
  const section: ExportSummary = {
    label: 'AI-drafted',
    model: payload.modelRef,
    generatedAt: new Date(payload.generatedAt).toISOString(),
    coverage: { retrieval: retrievalLine(input.reading), summary: summaryLine(sentences.map((sentence) => ({ text: sentence.text, cites: sentence.cites.map((cite) => canonicalText(cite.ref)) })), input.reading) },
    sentences,
  };
  return { status: 'ok', section, runId: payload.runId, kept: sentences.length, dropped };
}

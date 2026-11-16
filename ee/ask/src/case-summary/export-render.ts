import type { CaseSummaryExportInput, CaseSummaryExportOutcome, EdgeRef, ElementRef, ExportSummary } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
import { assembleText } from './assemble.js';
import { judgeSentences } from './checks.js';
import { retrievalLine, summaryLine } from './coverage.js';
import { openToken } from './token.js';
import type { TokenKeys } from './token-keys.js';

type Cite = ExportSummary['sentences'][number]['cites'][number];

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
  const nodes = new Map(input.reading.nodes.map((node) => [canonicalText(node.ref), node]));
  const edges = new Map(input.reading.edges.map((edge) => [canonicalText(edge.ref), edge]));
  const inputs = new Map(payload.inputRefs.map((sent) => [sent.key, sent]));
  const assembled = assembleText(input.reading);
  const keyOfRef = new Map([...assembled.keys].map(([key, element]) => [`${element.kind}:${canonicalText(element.ref)}`, key]));
  const sentences: ExportSummary['sentences'] = [];
  const draftedBeforeMasking = !payload.mask && [...input.reading.nodes, ...input.reading.edges].some((element) => element.properties.some((property) => property.masked));
  for (const sentence of draftedBeforeMasking ? [] : payload.sentences) {
    const cites: Cite[] = [];
    const current: string[] = [];
    let whole = sentence.cites.length > 0;
    for (const key of new Set(sentence.cites)) {
      const sent = inputs.get(key);
      const found = sent === undefined ? undefined : sent.kind === 'entity' ? nodes.get(canonicalText(sent.ref)) : edges.get(canonicalText(sent.ref));
      if (sent === undefined || found === undefined) {
        whole = false;
        break;
      }
      const now = keyOfRef.get(`${sent.kind}:${canonicalText(sent.ref)}`);
      if (now === undefined) {
        whole = false;
        break;
      }
      current.push(now);
      cites.push(sent.kind === 'entity' ? { kind: 'entity', ref: found.ref as ElementRef } : { kind: 'relationship', ref: found.ref as EdgeRef });
    }
    if (!whole) continue;
    const [judged] = judgeSentences([{ text: sentence.text, cites: current }], assembled).kept;
    if (judged !== undefined) sentences.push({ text: judged.text, cites });
  }
  const section: ExportSummary = {
    label: 'AI-drafted',
    model: payload.modelRef,
    generatedAt: new Date(payload.generatedAt).toISOString(),
    coverage: { retrieval: retrievalLine(input.reading), summary: summaryLine(sentences.map((sentence) => ({ text: sentence.text, cites: sentence.cites.map((cite) => canonicalText(cite.ref)) })), input.reading) },
    sentences,
  };
  return { status: 'ok', section, runId: payload.runId, kept: sentences.length, dropped: payload.sentences.length - sentences.length };
}

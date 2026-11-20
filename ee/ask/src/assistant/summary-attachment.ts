import { edgeRefSchema, elementRefSchema, type ElementRefs } from '@neburyx/contracts';
import { openToken, type OpenedToken } from '../case-summary/token.js';
import type { TokenKeys } from '../case-summary/token-keys.js';

type Payload = Extract<OpenedToken, { readonly ok: true }>['payload'];

/** An AI case summary the person keeps attached to the thread, opened for one turn: the sealed draft and the references of the elements its sentences cite. */
export interface SummaryAttachment {
  readonly payload: Payload;
  readonly refs: ElementRefs;
}

export const ATTACHED_SUMMARY_LINE = 'An AI case summary of this investigation is attached to this turn.';

/** The references of the elements the sentences of a draft cite, each once, that read as references. */
function citedRefs(payload: Payload, sourceId: string): ElementRefs {
  const cited = new Set(payload.sentences.flatMap((sentence) => sentence.cites));
  const entities: ElementRefs['entities'][number][] = [];
  const edges: ElementRefs['edges'][number][] = [];
  const aggregates: ElementRefs['aggregates'][number][] = [];
  const derived: ElementRefs['derived'][number][] = [];
  for (const sent of payload.inputRefs) {
    if (!cited.has(sent.key)) continue;
    if (sent.kind === 'entity') {
      const read = elementRefSchema.safeParse(sent.ref);
      if (read.success && read.data.sourceId === sourceId) entities.push(read.data);
      continue;
    }
    const read = edgeRefSchema.safeParse(sent.ref);
    if (!read.success || read.data.sourceId !== sourceId) continue;
    if ('aggregate' in read.data) aggregates.push(read.data);
    else if ('derived' in read.data) derived.push(read.data);
    else edges.push(read.data);
  }
  return { entities, edges, aggregates, derived };
}

/** Opens a summary token for this person, investigation and policy version; absent when it does not open, for whatever cause. */
export function openAttachment(keys: TokenKeys | undefined, token: string, context: { readonly sourceId: string; readonly investigationId: string; readonly actorId: string; readonly policyVersion: string; readonly now: number }): SummaryAttachment | undefined {
  if (keys === undefined) return undefined;
  const opened = openToken(keys, token, { investigationId: context.investigationId, actorId: context.actorId, policyVersion: context.policyVersion, now: context.now });
  return opened.ok ? { payload: opened.payload, refs: citedRefs(opened.payload, context.sourceId) } : undefined;
}

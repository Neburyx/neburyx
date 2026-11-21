import { MAX_READ_REFS, valueNotFitSentence, type AskAnswer, type AskEntities, type AskIntent, type AskValueNotFitKind, type ElementRefs, type ExtensionRequest, type SummaryReading } from '@neburyx/contracts';
import { roleEntityType } from '../assistant/clarification.js';

/** A value the person wrote for a role of an intent, and the entity type that role needs. */
export interface WrittenValue {
  readonly role: string;
  readonly value: string;
  readonly needed: string;
}

/** An element of another mapped type that has the written value as its stable id, with the title the gate gave it. */
interface FoundElement {
  readonly ref: { readonly sourceId: string; readonly entityType: string; readonly stableId: string };
  readonly title: string;
  readonly type: string;
}

/** What a written value is: an element of the type its role needs, an element only of other types (every one, in the mapping's order), nothing, or not known to exist because the read left something out. */
export type ValueVerdict = { readonly kind: 'fits' } | { readonly kind: 'other-type'; readonly found: readonly FoundElement[] } | { readonly kind: 'none' } | { readonly kind: 'hidden' };

export interface CheckedValue extends WrittenValue {
  readonly verdict: ValueVerdict;
}

export interface LookupInput {
  readonly sourceId: string;
  /** The entity types of the source's mapping, in the mapping's order. */
  readonly types: readonly string[];
  readonly values: readonly WrittenValue[];
  /** One read of elements through the gate; a failed read rejects and is never taken as an absent element. */
  readonly read: (refs: ElementRefs) => Promise<Pick<SummaryReading, 'nodes' | 'omitted'>>;
}

/**
 * What each written value is, through the gate: for every value one reference of the type its role needs and one of each other type of the mapping, as stable ids only (values travel as parameters of the gate's read of
 * elements, never as text of a query). The references go in reads of at most `MAX_READ_REFS`, a value's references always together, so the flag a read gives that something was left out applies to the values it holds.
 * An element is `fits` when the type is the needed one (even if another type has the id too), `other-type` when only other types have it, `hidden` when nothing was found and the read left something out, and `none` otherwise.
 */
export async function lookupWrittenValues(input: LookupInput): Promise<readonly CheckedValue[]> {
  const { sourceId, types, values } = input;
  if (values.length === 0) return [];
  const perValue = Math.max(1, types.length);
  const perRead = Math.max(1, Math.floor(MAX_READ_REFS / perValue));
  const checked: CheckedValue[] = [];
  for (let start = 0; start < values.length; start += perRead) {
    const group = values.slice(start, start + perRead);
    const reading = await input.read({ entities: group.flatMap((entry) => types.map((entityType) => ({ sourceId, entityType, stableId: entry.value }))), edges: [], aggregates: [], derived: [] });
    for (const entry of group) {
      const nodes = reading.nodes.filter((node) => node.ref.stableId === entry.value);
      const same = nodes.find((node) => node.ref.entityType === entry.needed);
      const others = types.flatMap((type) => (type === entry.needed ? [] : nodes.filter((node) => node.ref.entityType === type).slice(0, 1))).map((node) => ({ ref: { sourceId: node.ref.sourceId, entityType: node.ref.entityType, stableId: node.ref.stableId }, title: node.display.title, type: node.display.type }));
      checked.push({ ...entry, verdict: same !== undefined ? { kind: 'fits' } : others.length > 0 ? { kind: 'other-type', found: others } : reading.omitted ? { kind: 'hidden' } : { kind: 'none' } });
    }
  }
  return checked;
}

/** The first written value, in the order given, that does not fit; undefined when every one does. */
export const firstMisfit = (checked: readonly CheckedValue[]): (CheckedValue & { readonly verdict: Exclude<ValueVerdict, { readonly kind: 'fits' }> }) | undefined => {
  for (const entry of checked) if (entry.verdict.kind !== 'fits') return entry as CheckedValue & { readonly verdict: Exclude<ValueVerdict, { readonly kind: 'fits' }> };
  return undefined;
};

/** Ask's refusal for a value that does not fit: the fixed sentence, the kind and the types, and for another type the first element found in the mapping's order, cited with the title the gate gave it. */
export function valueNotFitAnswer(misfit: ReturnType<typeof firstMisfit> & object, intent: string | undefined): AskAnswer {
  const { verdict, needed } = misfit;
  const kind: AskValueNotFitKind = verdict.kind === 'other-type' ? 'other-type' : verdict.kind === 'none' ? 'not-found' : 'hidden';
  const first = verdict.kind === 'other-type' ? verdict.found[0] : undefined;
  const fit = first === undefined ? { kind, needed } : { kind, needed, found: first.type, citation: { ref: first.ref, title: first.title, type: first.type } };
  return { refused: { cause: 'value-not-fit', sentence: valueNotFitSentence({ kind, needed, found: first?.type, title: first?.title }), ...(intent === undefined ? {} : { intent }), valueNotFit: fit } };
}

export interface IntentValuesInput {
  readonly sourceId: string;
  readonly mask: boolean;
  readonly signal: AbortSignal;
  readonly intent: AskIntent;
  /** The values the person wrote, by role: not the ones the server resolved from a key, which are checked already. */
  readonly written: AskEntities;
  /** The entity types of the source's mapping, in the mapping's order; absent, only the type each role needs is looked up. */
  readonly types?: readonly string[] | undefined;
  /** The read of elements for a route with no investigation; absent (an edition without it), the values are not checked. */
  readonly readSource: ExtensionRequest['readSourceElements'];
}

/**
 * The written values of an intent that have an entity type their role needs (a role no setting places has none and is not checked), looked up through the gate. The refusal of the first that does not fit, in the order of the
 * intent's parameters, or undefined when every one fits, when no value has a type or when the edition gives no read. A read that fails rejects, for the caller to answer as it answers any read of the turn.
 */
export async function checkIntentValues(input: IntentValuesInput): Promise<AskAnswer | undefined> {
  const { intent, readSource } = input;
  if (readSource === undefined) return undefined;
  const values = intent.parameters.flatMap((role) => {
    const value = input.written[role];
    const needed = value === undefined ? undefined : roleEntityType(intent, role);
    return value === undefined || needed === undefined ? [] : [{ role, value, needed }];
  });
  if (values.length === 0) return undefined;
  const types = input.types !== undefined && input.types.length > 0 ? input.types : [...new Set(values.map((entry) => entry.needed))];
  const misfit = firstMisfit(await lookupWrittenValues({ sourceId: input.sourceId, types, values, read: (refs) => readSource({ sourceId: input.sourceId, mask: input.mask, signal: input.signal }, refs) }));
  return misfit === undefined ? undefined : valueNotFitAnswer(misfit, intent.name);
}

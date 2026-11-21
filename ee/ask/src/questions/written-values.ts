import { ASK_SUMMARY_MAX_SENTENCE_LENGTH, MAX_READ_REFS, valueNotFitSentence, type AskAnswer, type AskEntities, type AskIntent, type AskValueNotFitKind, type ElementRefs, type ExtensionRequest, type SummaryReading, type TypeDescriptions } from '@neburyx/contracts';
import { roleEntityType } from '../assistant/clarification.js';

/** A value the person wrote for a role of an intent, and the entity type that role needs. */
export interface WrittenValue {
  readonly role: string;
  readonly value: string;
  readonly needed: string;
  /** How the mapping names the needed type for a person (its display name); absent, the type's own name. */
  readonly neededLabel?: string | undefined;
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
  /** The types whose identifiers are tokens the server made: a typed value cannot stand for one, so they are never looked up, and a value whose role needs one is `hidden`, not looked up. */
  readonly keyed?: ReadonlySet<string> | undefined;
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
  const { sourceId, values } = input;
  const keyed = input.keyed ?? new Set<string>();
  if (values.length === 0) return [];
  // the other types looked up are the ones whose identifiers a typed value can stand for; a value whose own type is keyed cannot be looked up at all
  const types = input.types.filter((type) => !keyed.has(type));
  const looked = values.filter((entry) => !keyed.has(entry.needed));
  const byValue = new Map<WrittenValue, CheckedValue>(values.filter((entry) => keyed.has(entry.needed)).map((entry) => [entry, { ...entry, verdict: { kind: 'hidden' } }]));
  const read = (entities: ElementRefs['entities']) => input.read({ entities, edges: [], aggregates: [], derived: [] });
  // first the type the role needs, one reference for each value: a value that fits is settled by that one read, which is the common case
  const left: { readonly entry: WrittenValue; readonly omitted: boolean }[] = [];
  for (let start = 0; start < looked.length; start += MAX_READ_REFS) {
    const group = looked.slice(start, start + MAX_READ_REFS);
    const reading = await read(group.map((entry) => ({ sourceId, entityType: entry.needed, stableId: entry.value })));
    for (const entry of group) {
      if (reading.nodes.some((node) => node.ref.entityType === entry.needed && node.ref.stableId === entry.value)) byValue.set(entry, { ...entry, verdict: { kind: 'fits' } });
      else left.push({ entry, omitted: reading.omitted });
    }
  }
  // then, only for the values that are not of that type, one reference of each other type, a value's references always together so that the flag a read gives that something was left out applies to the values it holds
  const perRead = Math.max(1, Math.floor(MAX_READ_REFS / Math.max(1, types.length - 1)));
  for (let start = 0; start < left.length; start += perRead) {
    const group = left.slice(start, start + perRead);
    const refs = group.flatMap(({ entry }) => types.filter((type) => type !== entry.needed).map((entityType) => ({ sourceId, entityType, stableId: entry.value })));
    const reading = refs.length === 0 ? { nodes: [], omitted: false } : await read(refs);
    for (const { entry, omitted } of group) {
      const nodes = reading.nodes.filter((node) => node.ref.stableId === entry.value);
      const others = types.flatMap((type) => (type === entry.needed ? [] : nodes.filter((node) => node.ref.entityType === type).slice(0, 1))).map((node) => ({ ref: { sourceId: node.ref.sourceId, entityType: node.ref.entityType, stableId: node.ref.stableId }, title: node.display.title, type: node.display.type }));
      byValue.set(entry, { ...entry, verdict: others.length > 0 ? { kind: 'other-type', found: others } : omitted || reading.omitted ? { kind: 'hidden' } : { kind: 'none' } });
    }
  }
  return values.flatMap((entry) => byValue.get(entry) ?? []);
}

/** The first written value, in the order given, that does not fit; undefined when every one does. */
export const firstMisfit = (checked: readonly CheckedValue[]): (CheckedValue & { readonly verdict: Exclude<ValueVerdict, { readonly kind: 'fits' }> }) | undefined => {
  for (const entry of checked) if (entry.verdict.kind !== 'fits') return entry as CheckedValue & { readonly verdict: Exclude<ValueVerdict, { readonly kind: 'fits' }> };
  return undefined;
};

/** A type's name as the sentence and the refusal carry it: at most what a refusal holds for one, cut at a code point. */
const shortType = (type: string): string => plainName([...type].slice(0, 64).join(''));

/** A type name as a sentence says it: a name the mapping starts with a capital letter (`Widget`) is written in lower case, an acronym or a name with a second capital (`IP address`) is left as it is. */
const plainName = (name: string): string => (/^[A-Z][a-z]/.test(name) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name);

/** The title the sentence names the element by: cut at a code point so that the whole sentence fits what a refusal's sentence may hold, whatever the title the gate gave. */
function titleOf(title: string, needed: string, found: string): string {
  // room is left for the longer ending, the one of a step of a tool loop, so that the same title serves both
  const room = ASK_SUMMARY_MAX_SENTENCE_LENGTH - valueNotFitSentence({ kind: 'other-type', needed, found, title: '', laterStep: true }).length - 1;
  const points = [...title];
  return points.length <= room ? title : `${points.slice(0, Math.max(0, room - 1)).join('')}…`;
}

/** Ask's refusal for a value that does not fit: the fixed sentence, the kind and the types, and for another type the first element found in the mapping's order, cited with the title the gate gave it. */
export function valueNotFitAnswer(misfit: ReturnType<typeof firstMisfit> & object, intent: string | undefined): AskAnswer {
  const { verdict } = misfit;
  const needed = shortType(misfit.neededLabel ?? misfit.needed);
  const kind: AskValueNotFitKind = verdict.kind === 'other-type' ? 'other-type' : verdict.kind === 'none' ? 'not-found' : 'hidden';
  const found = verdict.kind === 'other-type' ? verdict.found[0] : undefined;
  const first = found === undefined ? undefined : { ...found, type: shortType(found.type) };
  const title = first === undefined ? undefined : titleOf(first.title, needed, first.type);
  const fit = first === undefined ? { kind, needed } : { kind, needed, found: first.type, citation: { ref: first.ref, title: title ?? first.title, type: first.type } };
  return { refused: { cause: 'value-not-fit', sentence: valueNotFitSentence({ kind, needed, found: first?.type, title }), ...(intent === undefined ? {} : { intent }), valueNotFit: fit } };
}

export interface IntentValuesInput {
  readonly sourceId: string;
  readonly mask: boolean;
  readonly signal: AbortSignal;
  readonly intent: AskIntent;
  /** The values the person wrote, by role: not the ones the server resolved from a key, which are checked already. */
  readonly written: AskEntities;
  /** What the mapping says of the source's entity types, in its order; absent, only the type each role needs is looked up. */
  readonly descriptions?: TypeDescriptions | undefined;
  /** The read of elements for a route with no investigation; absent (an edition without it), the values are not checked. */
  readonly readSource: ExtensionRequest['readSourceElements'];
}

/** What the mapping says of the types a lookup touches: their order, the ones whose identifiers are tokens, and how each is named for a person. */
function typeInfoOf(descriptions: TypeDescriptions | undefined, needed: readonly string[]): { readonly types: readonly string[]; readonly keyed: ReadonlySet<string>; readonly label: (type: string) => string | undefined } {
  const entries = descriptions?.entityTypes ?? [];
  return {
    types: entries.length > 0 ? entries.map((entry) => entry.type) : [...new Set(needed)],
    keyed: new Set(entries.filter((entry) => entry.keyed === true).map((entry) => entry.type)),
    label: (type) => entries.find((entry) => entry.type === type)?.displayName,
  };
}

/** The refusal for the first of the values that does not fit, or undefined; a read that fails rejects, for the caller to answer as it answers any read of the turn. */
export async function refusalOfValues(input: { readonly sourceId: string; readonly mask: boolean; readonly signal: AbortSignal; readonly intent: string; readonly values: readonly { readonly role: string; readonly value: string; readonly needed: string }[]; readonly descriptions?: TypeDescriptions | undefined; readonly readSource: NonNullable<ExtensionRequest['readSourceElements']> }): Promise<AskAnswer | undefined> {
  if (input.values.length === 0) return undefined;
  const info = typeInfoOf(input.descriptions, input.values.map((entry) => entry.needed));
  const values = input.values.map((entry) => ({ ...entry, neededLabel: info.label(entry.needed) }));
  const misfit = firstMisfit(await lookupWrittenValues({ sourceId: input.sourceId, types: info.types, keyed: info.keyed, values, read: (refs) => input.readSource({ sourceId: input.sourceId, mask: input.mask, signal: input.signal }, refs) }));
  return misfit === undefined ? undefined : valueNotFitAnswer(misfit, input.intent);
}

/**
 * The written values of an intent that have an entity type their role needs (a role no setting places has none and is not checked), looked up through the gate. The refusal of the first that does not fit, in the order of the
 * intent's parameters, or undefined when every one fits, when no value has a type or when the edition gives no read.
 */
export async function checkIntentValues(input: IntentValuesInput): Promise<AskAnswer | undefined> {
  const { intent, readSource } = input;
  if (readSource === undefined) return undefined;
  const values = intent.parameters.flatMap((role) => {
    const value = input.written[role];
    const needed = value === undefined ? undefined : roleEntityType(intent, role);
    return value === undefined || needed === undefined ? [] : [{ role, value, needed }];
  });
  return refusalOfValues({ sourceId: input.sourceId, mask: input.mask, signal: input.signal, intent: intent.name, values, descriptions: input.descriptions, readSource });
}

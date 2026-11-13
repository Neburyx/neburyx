import { ASK_REFUSAL_FAMILIES, type AskRefusalFamily } from '@neburyx/contracts';

/** The fixed sentence of each refusal family: what the investigator is told, in place of any text of the model. */
export const REFUSAL_SENTENCES: Readonly<Record<AskRefusalFamily, string>> = {
  path: 'This question asks how two things are connected through a chain of links. Ask cannot answer that.',
  'property-selection': 'This question asks to pick records by the value of a property. Ask cannot answer that.',
  'similar-records': 'This question asks for records that look alike, such as similar names or near matches. Ask cannot answer that.',
  'ranking-or-aggregate': 'This question asks for a ranking, a total or another figure worked out across many records. Ask cannot answer that.',
  'attribute-combination': 'This question asks to combine several attributes of the records at once. Ask cannot answer that.',
  'indirect-attribute': 'This question asks about an attribute that belongs to a neighbouring record and not to the record itself. Ask cannot answer that.',
  'unnamed-relation': 'This question names a kind of link that the source does not define. Ask cannot answer that.',
  judgement: 'This question asks for a judgement or a conclusion rather than for records. Ask cannot answer that.',
  'personal-data': 'This question asks for personal details that Ask does not work with. Ask cannot answer that.',
  'loaded-view': 'This question asks about what is shown on the screen, which Ask does not read. Ask cannot answer that.',
  other: 'Ask has no way to answer this question.',
  'plan-not-usable': 'Ask could not turn this question into a plan it can run.',
  'model-refused': 'The assistant declined to work on this question.',
};

const MAX_SENTENCE_LENGTH = 300;
export { MAX_SENTENCE_LENGTH };

const MODEL_SELECTABLE_EXCLUDED: ReadonlySet<AskRefusalFamily> = new Set(['plan-not-usable', 'model-refused']);

/** The families the model may name. */
export const MODEL_FAMILIES: readonly AskRefusalFamily[] = ASK_REFUSAL_FAMILIES.filter((family) => !MODEL_SELECTABLE_EXCLUDED.has(family));

export function isModelFamily(value: unknown): value is AskRefusalFamily {
  return typeof value === 'string' && (MODEL_FAMILIES as readonly string[]).includes(value);
}

/** The refusal the route answers: the family the planner named (or `other`) and the fixed sentence of that family. */
export function fixedRefusal(family: AskRefusalFamily | undefined): { readonly kind: 'unsupported'; readonly family: AskRefusalFamily; readonly reason: string } {
  const chosen = family !== undefined && Object.hasOwn(REFUSAL_SENTENCES, family) ? family : 'other';
  return { kind: 'unsupported', family: chosen, reason: REFUSAL_SENTENCES[chosen] };
}

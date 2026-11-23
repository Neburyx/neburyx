import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_CLASSES, countSchema, type Count, type GraphEdge, type GraphNode, type SummaryReading } from '@neburyx/contracts';
import { parse } from 'yaml';
import { z } from 'zod';
import { defined } from './checks.js';
import { edge, node, prop, reading } from './view.js';

const here = dirname(fileURLToPath(import.meta.url));
const CASES_FILE = resolve(here, '../cases/cases.yaml');

const id = z.string().min(1);
/** A property as the file writes it: text, or a typed value with its data class and whether it is masked (the class and the mask are what the gate returns with a value). */
const typedPropertySchema = z.strictObject({ value: z.union([z.string(), z.number()]), class: z.enum(DATA_CLASSES), masked: z.boolean().optional() });
const entitySchema = z.strictObject({ key: id, type: id, id, name: id, props: z.record(z.string(), z.union([z.string(), typedPropertySchema])).optional() });
const relationshipSchema = z.strictObject({ key: id, type: id, from: id, to: id, observed_at: id.optional() });
const factSchema = z.strictObject({ id, says: id, phrases: z.array(id).min(1), rests_on: z.array(id).min(1) });
const claimSchema = z.strictObject({ id, says: id, phrases: z.array(id).min(1), about: z.array(id).min(1) });
const RULES = ['citation', 'number', 'name', 'verdict', 'comparison'] as const;
const sentenceSchema = z.strictObject({ id, label: z.enum(['keep', 'remove']), rule: z.enum(RULES).optional(), known_slip: z.boolean().optional(), plain_view: z.boolean().optional(), text: id, cites: z.array(id) });
/** A count as the file writes it: the contract's own count, which the file gives without its scope. */
const fileCountSchema = z.strictObject({ value: z.number().optional(), quality: z.string() });

const caseSchema = z
  .strictObject({
    id,
    pack: z.enum(['banking-fraud', 'insurance-claims']),
    source_case: id.optional(),
    shape: id.optional(),
    title: id,
    not_retrieved: fileCountSchema.optional(),
    entities: z.array(entitySchema).min(2),
    relationships: z.array(relationshipSchema),
    facts: z.array(factSchema).min(1),
    claims: z.array(claimSchema).min(1),
    invented_names: z.array(id).min(1),
    sentences: z.array(sentenceSchema).min(1),
  })
  .superRefine((value, context) => {
    const complain = (message: string): void => context.addIssue({ code: 'custom', message });
    const keys = [...value.entities.map((entity) => entity.key), ...value.relationships.map((relationship) => relationship.key)];
    const known = new Set(keys);
    if (known.size !== keys.length) complain('an element key is used twice');
    const entityKeys = new Set(value.entities.map((entity) => entity.key));
    for (const relationship of value.relationships) if (!entityKeys.has(relationship.from) || !entityKeys.has(relationship.to)) complain(`relationship ${relationship.key} names an entity the view does not hold`);
    for (const fact of value.facts) for (const key of fact.rests_on) if (!known.has(key)) complain(`fact ${fact.id} rests on ${key}, which is not in the view`);
    for (const claim of value.claims) for (const key of claim.about) if (!known.has(key)) complain(`claim ${claim.id} is about ${key}, which is not in the view`);
    for (const sentence of value.sentences) {
      for (const key of sentence.cites) if (!known.has(key)) complain(`sentence ${sentence.id} cites ${key}, which is not in the view`);
      if ((sentence.label === 'remove') !== (sentence.rule !== undefined)) complain(`sentence ${sentence.id}: a remove label names its rule, a keep label names none`);
      if (sentence.known_slip === true && sentence.rule !== 'name') complain(`sentence ${sentence.id}: only a name that the name check lets through is a known slip`);
    }
    const held = JSON.stringify([value.entities, value.relationships]);
    for (const name of value.invented_names) if (held.includes(name)) complain(`the invented name ${name} is in the view`);
    if ((value.source_case === undefined) === (value.shape === undefined)) complain('a case is a demo view (source_case) or an AML view (shape), not both and not neither');
    if (value.not_retrieved !== undefined && !countSchema.safeParse({ ...value.not_retrieved, scope: 'coverage' }).success) complain('not_retrieved is not a valid count');
  });

const fileSchema = z.strictObject({ version: z.literal(1), synthetic_names: z.array(id).min(1), cases: z.array(caseSchema).min(1) });

export type LabelledCase = z.infer<typeof caseSchema>;
export type LabelledSentence = LabelledCase['sentences'][number];
export interface LabelledSet {
  readonly syntheticNames: readonly string[];
  readonly cases: readonly LabelledCase[];
}

/** Parses and validates the text of the file; an invalid file fails with the case named. */
export function parseCases(text: string): LabelledSet {
  const raw: unknown = parse(text);
  const parsed = fileSchema.safeParse(raw);
  if (parsed.success) return { syntheticNames: parsed.data.synthetic_names, cases: parsed.data.cases };
  const issue = parsed.error.issues[0];
  const path = issue?.path ?? [];
  const index = path[0] === 'cases' ? path[1] : undefined;
  const listed = z.object({ cases: z.array(z.object({ id: z.string() }).partial()) }).safeParse(raw);
  const named = typeof index === 'number' && listed.success ? listed.data.cases[index]?.id : undefined;
  throw new Error(`the labelled set is invalid${named === undefined ? '' : ` in the case ${named}`}: ${issue?.message ?? 'unknown'} (at ${path.join('.')})`);
}

export const loadCases = (): LabelledSet => parseCases(readFileSync(CASES_FILE, 'utf8'));

export const caseOf = (set: LabelledSet, index: number): LabelledCase => defined(set.cases[index], `the case at ${index}`);

const countOf = (count: z.infer<typeof fileCountSchema>): Count => countSchema.parse({ ...count, scope: 'coverage' });

/** The view of a case as the summarizer reads it. */
export function readingOf(labelled: LabelledCase): SummaryReading {
  const nodes = new Map<string, GraphNode>(labelled.entities.map((entity) => [entity.key, node(entity.type, entity.id, entity.name, Object.entries(entity.props ?? {}).map(([key, value]) => (typeof value === 'string' ? prop(key, value) : prop(key, value.value, value.masked === true, value.class))))]));
  const edges: GraphEdge[] = labelled.relationships.map((relationship) =>
    edge(relationship.type, relationship.key, defined(nodes.get(relationship.from), relationship.from).ref, defined(nodes.get(relationship.to), relationship.to).ref, relationship.observed_at === undefined ? {} : { observedAt: relationship.observed_at }),
  );
  return reading([...nodes.values()], edges, labelled.not_retrieved === undefined ? {} : { notRetrieved: countOf(labelled.not_retrieved) });
}

/** The key of the sent text that each element of a case received: an entity by its id, a relationship by its type and the keys of its two ends. */
export function keyMapOf(labelled: LabelledCase, sent: string): Map<string, string> {
  const lines = sent.split('\n');
  const map = new Map<string, string>();
  for (const entity of labelled.entities) {
    const line = lines.find((candidate) => /^n\d+ \|/u.test(candidate) && candidate.includes(`id: ${JSON.stringify(entity.id)}`));
    if (line !== undefined) map.set(entity.key, line.slice(0, line.indexOf(' ')));
  }
  const used = new Set<string>();
  for (const relationship of labelled.relationships) {
    const from = map.get(relationship.from);
    const to = map.get(relationship.to);
    const line = lines.find((candidate) => /^e\d+ \|/u.test(candidate) && !used.has(candidate) && candidate.includes(`${JSON.stringify(relationship.type)} | ${from} -> ${to} |`));
    if (line !== undefined) {
      used.add(line);
      map.set(relationship.key, line.slice(0, line.indexOf(' ')));
    }
  }
  return map;
}

/** The sentence as the checks see it, with the keys of its elements as the sent text numbered them. */
export function sentenceInKeys(sentence: LabelledSentence, keys: ReadonlyMap<string, string>): { readonly text: string; readonly cites: string[] } {
  return { text: sentence.text, cites: sentence.cites.map((key) => defined(keys.get(key), `the key of ${key}`)) };
}

/** The data class of each property key of a case, as the file declares it: the sent text does not carry the class, so the suite's own ranking rule takes it from here. */
export function classesOf(labelled: LabelledCase): ReadonlyMap<string, string> {
  return new Map(labelled.entities.flatMap((entity) => Object.entries(entity.props ?? {}).flatMap(([key, value]) => (typeof value === 'string' || value.masked === true ? [] : [[key, value.class] as const]))));
}

/** The keep sentences of a view that a suite which adds its own evidence to the view may draft: a ranking is judged on the view as the case gives it, and that evidence (a property on one entity) changes the properties the cited elements show. */
export const keepersOf = (labelled: LabelledCase): readonly LabelledSentence[] => labelled.sentences.filter((sentence) => sentence.label === 'keep' && sentence.plain_view !== true);

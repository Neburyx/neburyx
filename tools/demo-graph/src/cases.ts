import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Definition, Issue } from './definition.js';
import { MAX_PRESET_CASE_REF, MAX_PRESET_TEXT, presetSchema } from './preset.js';
import type { MappingSource } from './mapping.js';
import type { ExportData } from './validate.js';

export class CasesError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(`the demo cases are not usable:\n${issues.map((issue) => `  ${issue.path}: ${issue.reason}`).join('\n')}`);
    this.name = 'CasesError';
    this.issues = issues;
  }
}

export const MAX_LISTED_IDS = 100;
export const MAX_CASE_REF = MAX_PRESET_CASE_REF;
const MAX_ISSUES = 50;

const name = z.string().min(1);

const casesSchema = z.strictObject({
  preset: presetSchema,
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        title: name,
        expect: z
          .array(
            z.strictObject({
              node: z.strictObject({ type: name, id: name }),
              via: name.optional(),
              direction: z.enum(['in', 'out']).optional(),
              ids: z.array(name).max(MAX_LISTED_IDS).optional(),
              count: z.number().int().min(0).optional(),
              property: name.optional(),
              equals: z.union([z.boolean(), z.string()]).optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export interface NodeRef {
  readonly type: string;
  readonly id: string;
}

export type Expectation =
  | {
      readonly kind: 'neighbors';
      readonly node: NodeRef;
      readonly via: string;
      readonly direction: 'in' | 'out';
      readonly neighbor: string;
      readonly answer: { readonly kind: 'ids'; readonly ids: readonly string[] } | { readonly kind: 'count'; readonly count: number };
    }
  | { readonly kind: 'property'; readonly node: NodeRef; readonly property: string; readonly equals: boolean | string };

export interface DemoCase {
  readonly id: string;
  readonly title: string;
  readonly expect: readonly Expectation[];
}

export interface Preset {
  readonly entity: NodeRef;
  readonly caseRef: string;
}

export interface Cases {
  readonly preset: Preset;
  readonly cases: readonly DemoCase[];
}

const REASONS: Readonly<Record<string, string>> = {
  unrecognized_keys: 'has a key the reader does not know',
  invalid_type: 'has the wrong kind of value',
  invalid_format: 'is not in the form the reader accepts',
  too_big: `holds more than the reader accepts (at most ${MAX_LISTED_IDS} stable IDs; use a count for a large answer)`,
  too_small: 'is empty or too short',
  invalid_value: 'is not one of the values the reader accepts',
  custom: `is empty, longer than the reader accepts (${MAX_PRESET_TEXT} code points for an entity type and an ID, ${MAX_CASE_REF} for a case reference) or holds a control character or an unpaired surrogate`,
};

function placeOf(path: readonly PropertyKey[]): string {
  return path.reduce<string>((place, step) => (typeof step === 'number' ? `${place}[${step}]` : place === '' ? String(step) : `${place}.${String(step)}`), '') || 'file';
}

export function parseCases(text: string, mapping: MappingSource, definition: Definition): Cases {
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new CasesError([{ path: 'file', reason: 'is not valid YAML' }]);
  let data: unknown;
  try {
    data = document.toJS();
  } catch {
    throw new CasesError([{ path: 'file', reason: 'is not valid YAML data (an alias that cannot be resolved or expanded)' }]);
  }
  const parsed = casesSchema.safeParse(data);
  if (!parsed.success) {
    throw new CasesError(parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => ({ path: placeOf(issue.path), reason: REASONS[issue.code] ?? 'does not have the shape of a cases file' })));
  }

  const issues: Issue[] = [];
  const report = (path: string, reason: string): void => {
    if (issues.length < MAX_ISSUES) issues.push({ path, reason });
  };
  const entities = new Map(mapping.entities.map((entity) => [entity.type, entity]));
  const relationships = new Map(mapping.relationships.map((relationship) => [relationship.type, relationship]));
  const generated = new Map(definition.entities.map((entity) => [entity.type, new Set(entity.properties.map((property) => property.key))]));
  const seen = new Set<string>();
  if (!entities.has(parsed.data.preset.entity.type)) report('preset', 'names an entity type the mapping does not have');

  const cases = parsed.data.cases.map((raw): DemoCase => {
    if (seen.has(raw.id)) report(`case ${raw.id}`, 'repeats the ID of another case');
    seen.add(raw.id);
    const expect = raw.expect.flatMap((entry, index): Expectation[] => {
      const place = `case ${raw.id}, expectation ${index + 1}`;
      if (!entities.has(entry.node.type)) {
        report(place, 'names an entity type the mapping does not have');
        return [];
      }
      if (entry.property !== undefined) {
        if (entry.via !== undefined || entry.direction !== undefined || entry.ids !== undefined || entry.count !== undefined) report(place, 'is a property expectation and must not also give via, direction, ids or count');
        if (entry.equals === undefined) report(place, 'gives a property and no value for it to equal');
        else if (generated.get(entry.node.type)?.has(entry.property) !== true) report(place, 'names a property the demo definition does not generate for that entity type');
        return entry.equals === undefined ? [] : [{ kind: 'property', node: entry.node, property: entry.property, equals: entry.equals }];
      }
      if (entry.equals !== undefined) report(place, 'gives a value to equal and no property');
      if (entry.via === undefined || entry.direction === undefined) {
        report(place, 'needs a via and a direction, or a property');
        return [];
      }
      if ((entry.ids === undefined) === (entry.count === undefined)) report(place, 'needs exactly one of ids and count');
      if (entry.ids !== undefined && new Set(entry.ids).size !== entry.ids.length) report(place, 'lists a stable ID more than once');
      const relationship = relationships.get(entry.via);
      if (relationship === undefined) {
        report(place, 'names a relationship type the mapping does not have');
        return [];
      }
      const near = entry.direction === 'out' ? relationship.from : relationship.to;
      if (near !== entry.node.type) {
        report(place, 'names a relationship type that does not touch the node in that direction');
        return [];
      }
      const neighbor = entry.direction === 'out' ? relationship.to : relationship.from;
      const answer = entry.ids !== undefined ? ({ kind: 'ids', ids: entry.ids } as const) : entry.count !== undefined ? ({ kind: 'count', count: entry.count } as const) : undefined;
      return answer === undefined ? [] : [{ kind: 'neighbors', node: entry.node, via: entry.via, direction: entry.direction, neighbor, answer }];
    });
    return { id: raw.id, title: raw.title, expect };
  });
  if (issues.length > 0) throw new CasesError(issues);
  return { preset: { entity: parsed.data.preset.entity, caseRef: parsed.data.preset.case_ref }, cases };
}

export function readCases(path: string, mapping: MappingSource, definition: Definition): Cases {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CasesError([{ path: 'file', reason: 'cannot be read' }]);
  }
  return parseCases(text, mapping, definition);
}

export function namedNodes(cases: Cases): { readonly place: string; readonly node: NodeRef }[] {
  const named = cases.cases.flatMap((demoCase) =>
    demoCase.expect.flatMap((expectation, index) => {
      const place = `case ${demoCase.id}, expectation ${index + 1}`;
      const listed = expectation.kind === 'neighbors' && expectation.answer.kind === 'ids' ? expectation.answer.ids.map((id) => ({ place, node: { type: expectation.neighbor, id } })) : [];
      return [{ place, node: expectation.node }, ...listed];
    }),
  );
  return [{ place: 'preset', node: cases.preset.entity }, ...named];
}

export function checkNamedNodes(cases: Cases, mapping: MappingSource, data: ExportData): void {
  const known = new Map<string, Set<unknown>>();
  for (const entity of mapping.entities) {
    const rows = data.entities.find((exported) => exported.type === entity.type)?.rows ?? [];
    known.set(entity.type, new Set(rows.map((row) => row[entity.stableId])));
  }
  const missing = namedNodes(cases).filter(({ node }) => known.get(node.type)?.has(node.id) !== true);
  if (missing.length > 0) throw new CasesError(missing.slice(0, MAX_ISSUES).map(({ place }) => ({ path: place, reason: 'names a node that is not in the export' })));
}

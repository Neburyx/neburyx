import { MAX_PATTERN_PROBLEMS, patternDefinitionSchema, type PatternAvailability, type PatternProblem } from '@neburyx/contracts';
import type { PatternRow } from '../db/patterns-repository.js';
import type { SourceModel } from '../mapping/model.js';
import { presetTemplateOf } from './preset-template.js';
import { validatePattern } from './validate.js';

type Reason = { readonly code: Extract<PatternAvailability, { status: 'unavailable' }>['reasons'][number]['code']; readonly path?: (string | number)[] };

/** The problems of a definition that say the mapping no longer has what it names, as the codes of a reason. */
const MAPPING_CODES = ['unknown-entity-type', 'unknown-relationship-type', 'relationship-does-not-join', 'unknown-property', 'not-filterable'] as const;
/** The problems the run answers as it answers the same definition through the run route, so they are not a reason: a source whose step limit was lowered, and a personal-data condition while the runner masks. */
const RUN_TIME_CODES: readonly PatternProblem['code'][] = ['too-many-hops', 'personal-data-masked'];

function definitionReasons(row: PatternRow, source: SourceModel): Reason[] {
  const problems = validatePattern(row.definition, source, { mask: false });
  const reasons: Reason[] = [];
  for (const problem of problems) {
    if (RUN_TIME_CODES.includes(problem.code)) continue;
    const mapping = MAPPING_CODES.find((code) => code === problem.code);
    reasons.push({ code: mapping ?? 'bad-definition', path: problem.path });
  }
  return reasons;
}

/** The type a pattern starts at now: the definition's own, or the type its preset starts from. */
export function startTypeOf(row: PatternRow, source: SourceModel): string | undefined {
  if (row.kind === 'definition') {
    const parsed = patternDefinitionSchema.safeParse(row.definition);
    return parsed.success ? parsed.data.anchorType : undefined;
  }
  return source.presets.find((candidate) => candidate.id === row.presetId)?.bind['anchor'];
}

function presetReasons(row: PatternRow, source: SourceModel): Reason[] {
  const preset = row.presetId === null ? undefined : source.presets.find((candidate) => candidate.id === row.presetId);
  if (preset === undefined) return [{ code: 'preset-removed' }];
  const template = presetTemplateOf(preset);
  const reasons: Reason[] = [];
  if (template.templateId !== row.templateId) reasons.push({ code: 'template-changed' });
  if (!template.schema.safeParse(row.params ?? {}).success) reasons.push({ code: 'params-invalid' });
  return reasons;
}

/**
 * Whether a stored pattern can run against the current mapping, judged from the stored content and the source's model alone: nothing is read from the source and no mask is asked. What a definition names that the mapping no longer
 * has, a definition that no longer passes the schema, a preset that is gone or now names another template or whose stored parameters no longer pass, and a held starting entity of a type the pattern no longer starts at, are reasons.
 * A stored template version is not compared. A source whose step limit was lowered and a personal-data condition while masking are answered by the run, as the run route answers them, and are not reasons. A reason holds a code and a path
 * and no name or value.
 */
export function availabilityOf(row: PatternRow, source: SourceModel): PatternAvailability {
  const reasons = row.kind === 'definition' ? definitionReasons(row, source) : presetReasons(row, source);
  const start = startTypeOf(row, source);
  if (row.anchorEntityType !== null && start !== undefined && row.anchorEntityType !== start) reasons.push({ code: 'anchor-changed' });
  const seen = new Set<string>();
  const unique = reasons.filter((reason) => {
    const key = JSON.stringify([reason.code, reason.path ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length === 0 ? { status: 'available' } : { status: 'unavailable', reasons: unique.slice(0, MAX_PATTERN_PROBLEMS) };
}

import { SAVED_PATTERN_TEMPLATE_VERSION, type AiMappingView, type AskPatternEntry, type AskPlan } from '@neburyx/contracts';
import { CATALOG } from './catalog.js';

const PLACEHOLDER = /‹([^#›]+)#(\d+)›/g;
const FALLBACK_KIND = 'entity';
const VALUE_KIND = 'value';

export interface PlanCheckInput {
  /** The previewed text the plan was made for: the only place a placeholder may come from. */
  readonly text: string;
  /** `placeholders` (the default) for a plan the model made, whose references are placeholders of `text`; `references` for the parameters of an edit, whose references are real ones the investigator gave. */
  readonly mode?: 'placeholders' | 'references';
  readonly view: AiMappingView | undefined;
  /** What a plan that names a saved pattern is checked against: the entries of the pattern catalog the model was shown, by key. */
  readonly patterns?: ReadonlyMap<string, AskPatternEntry>;
}

type PlanOf = Extract<AskPlan, { kind: 'plan' }>;

function placeholdersOf(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[0]));
}

function kindOf(placeholder: string): string | undefined {
  const [, kind] = /^‹([^#›]+)#\d+›$/.exec(placeholder) ?? [];
  return kind;
}

function names(view: AiMappingView | undefined) {
  const types = view?.types ?? [];
  return {
    entities: new Set(types.filter((type) => type.kind === 'entity').map((type) => type.name)),
    relationships: new Set(types.filter((type) => type.kind === 'relationship').map((type) => type.name)),
    rules: new Set((view?.derivedRules ?? []).map((rule) => rule.id)),
  };
}

/** The problems of a plan against the catalog, the vocabulary and the text it was made for, as paths and codes: none means the plan may leave the planner. */
export function problemsOfPlan(plan: AskPlan, input: PlanCheckInput): readonly string[] {
  if (plan.kind !== 'plan') return [];
  const problems: string[] = [];
  const known = names(input.view);
  const present = placeholdersOf(input.text);
  const literal = input.mode === 'references';
  if (plan.templateId === 'saved-pattern') {
    if (plan.templateVersion !== SAVED_PATTERN_TEMPLATE_VERSION) problems.push('templateVersion: not the version of the saved pattern plan');
  } else {
    const entry = CATALOG.find((candidate) => candidate.id === plan.templateId);
    if (entry === undefined) return ['templateId: not a template of the catalog'];
    if (plan.templateVersion !== entry.version) problems.push('templateVersion: not the version of the catalog');
  }

  const entityType = (path: string, value: string | undefined): void => {
    if (value !== undefined && !known.entities.has(value)) problems.push(`${path}: not an entity type of the vocabulary`);
  };
  const relationshipType = (path: string, value: string): void => {
    if (!known.relationships.has(value)) problems.push(`${path}: not a relationship type of the vocabulary`);
  };
  const entityPlaceholder = (path: string, ref: { readonly entityType: string; readonly stableId: string }): void => {
    if (literal) {
      entityType(`${path}.entityType`, ref.entityType);
      return;
    }
    const kind = kindOf(ref.stableId);
    if (kind === undefined || kind === VALUE_KIND || !present.has(ref.stableId)) {
      problems.push(`${path}.stableId: not an entity placeholder of the question`);
      return;
    }
    if (kind === FALLBACK_KIND ? !known.entities.has(ref.entityType) : ref.entityType !== kind) problems.push(`${path}.entityType: does not match the placeholder`);
  };
  const rule = (path: string, value: string): void => {
    if (!known.rules.has(value)) problems.push(`${path}: not a derived rule of the vocabulary`);
  };

  const check = (candidate: PlanOf): void => {
    switch (candidate.templateId) {
      case 'shared-attribute':
        entityPlaceholder('params.ref', candidate.params.ref);
        entityType('params.attributeType', candidate.params.attributeType);
        if (candidate.params.via !== undefined) relationshipType('params.via', candidate.params.via);
        break;
      case 'linked-entities':
        entityPlaceholder('params.ref', candidate.params.ref);
        entityType('params.targetType', candidate.params.targetType);
        for (const [index, via] of (candidate.params.via ?? []).entries()) relationshipType(`params.via.${index}`, via);
        break;
      case 'entity':
      case 'degree-preview':
        entityPlaceholder('params.ref', candidate.params.ref);
        break;
      case 'expand':
        entityPlaceholder('params.ref', candidate.params.ref);
        for (const [index, type] of candidate.params.neighborTypes.entries()) entityType(`params.neighborTypes.${index}`, type);
        for (const [index, via] of (candidate.params.relTypes ?? []).entries()) relationshipType(`params.relTypes.${index}`, via);
        break;
      case 'derived-rule-run':
        entityPlaceholder('params.ref', candidate.params.ref);
        rule('params.ruleId', candidate.params.ruleId);
        break;
      case 'derived-edge-support':
        rule('params.ruleId', candidate.params.ruleId);
        for (const [index, end] of candidate.params.ends.entries()) entityPlaceholder(`params.ends.${index}`, end);
        break;
      case 'saved-pattern': {
        if (!('patternKey' in candidate.params)) {
          problems.push('params.patternKey: a saved pattern is named by its key');
          break;
        }
        const offered = input.patterns?.get(candidate.params.patternKey);
        if (offered === undefined) {
          problems.push('params.patternKey: not a key of the saved patterns offered');
          break;
        }
        const { ref } = candidate.params;
        if (offered.startingEntity === 'held') {
          if (ref !== undefined) problems.push('params.ref: the saved pattern holds its starting entity');
          break;
        }
        if (ref === undefined) {
          problems.push('params.ref: the saved pattern asks for its starting entity');
          break;
        }
        entityPlaceholder('params.ref', ref);
        if (ref.entityType !== offered.anchorType) problems.push('params.ref.entityType: not the type the saved pattern starts at');
        break;
      }
      case 'search':
        for (const [index, type] of candidate.params.entityTypes.entries()) entityType(`params.entityTypes.${index}`, type);
        if (!literal && (kindOf(candidate.params.text) !== VALUE_KIND || !present.has(candidate.params.text))) problems.push('params.text: not a value placeholder of the question');
        break;
      default: {
        const unreachable: never = candidate;
        return unreachable;
      }
    }
  };
  check(plan);
  return problems;
}

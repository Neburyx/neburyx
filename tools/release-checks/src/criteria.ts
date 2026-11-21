import type { Feature } from './args.js';
import type { CheckResult, CriterionResult } from './types.js';

export interface CriterionDefinition {
  readonly id: string;
  readonly text: string;
  readonly checks: readonly string[];
  readonly features?: Readonly<Record<string, Feature>>;
  readonly figure: (results: ReadonlyMap<string, CheckResult>) => string;
}

const figureOf = (result: CheckResult | undefined): string => {
  const data = result?.data as { readonly figure?: unknown } | undefined;
  return typeof data?.figure === 'string' ? data.figure : (result?.detail ?? 'not run');
};

export const figureOfChecks =
  (checks: readonly string[]) =>
  (results: ReadonlyMap<string, CheckResult>): string =>
    checks.filter((id) => results.has(id)).map((id) => figureOf(results.get(id))).join('; ');

const wordsOf = (feature: Feature): string => (feature === 'summary' ? 'AI case summary' : 'assistant');

export function checksKept(definitions: readonly CriterionDefinition[], cut: readonly Feature[]): ReadonlySet<string> {
  return new Set(definitions.flatMap((definition) => definition.checks.filter((id) => !cut.includes(definition.features?.[id] as Feature))));
}

/**
 * The criteria a catalogue covers: a criterion is shown only when every check it still rests on was run and is passed only when each of them passed. A check that rests on a cut feature is dropped with it; a criterion with no check left is `dropped`, and one that keeps some says which part was dropped.
 */
export function criteriaOf(definitions: readonly CriterionDefinition[], results: readonly CheckResult[], cut: readonly Feature[] = []): readonly CriterionResult[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return definitions.flatMap((definition): CriterionResult[] => {
    const left = definition.checks.filter((id) => !cut.includes(definition.features?.[id] as Feature));
    const droppedParts = definition.checks.filter((id) => !left.includes(id)).map((id) => `the ${wordsOf(definition.features?.[id] as Feature)} part: the feature is cut`);
    if (left.length === 0) return [{ id: definition.id, text: definition.text, checks: definition.checks, status: 'dropped', figure: 'dropped: the feature is cut', dropped: droppedParts }];
    if (!left.every((id) => byId.has(id))) return [];
    return [{
      id: definition.id,
      text: definition.text,
      checks: left,
      status: left.every((id) => byId.get(id)?.status === 'passed') ? 'passed' : 'failed',
      figure: [definition.figure(byId), ...droppedParts.map((part) => `dropped: ${part}`)].filter((part) => part !== '').join('; '),
      ...(droppedParts.length === 0 ? {} : { dropped: droppedParts }),
    }];
  });
}

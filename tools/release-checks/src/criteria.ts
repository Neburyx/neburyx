import type { CheckResult, CriterionResult } from './types.js';

/** One criterion of a gate: what it says, the checks it rests on, and how its figure is written from their data. */
export interface CriterionDefinition {
  readonly id: string;
  readonly text: string;
  readonly checks: readonly string[];
  readonly figure: (results: ReadonlyMap<string, CheckResult>) => string;
}

const figureOf = (result: CheckResult | undefined): string => {
  const data = result?.data as { readonly figure?: unknown } | undefined;
  return typeof data?.figure === 'string' ? data.figure : (result?.detail ?? 'not run');
};

/** The figure of a criterion that rests on one check or more: the check's own, joined. */
export const figureOfChecks =
  (checks: readonly string[]) =>
  (results: ReadonlyMap<string, CheckResult>): string =>
    checks.map((id) => figureOf(results.get(id))).join('; ');

/** The criteria a catalogue covers: a criterion is shown only when every check it rests on was run, and is passed only when each of them passed. */
export function criteriaOf(definitions: readonly CriterionDefinition[], results: readonly CheckResult[]): readonly CriterionResult[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return definitions
    .filter((definition) => definition.checks.every((id) => byId.has(id)))
    .map((definition) => ({
      id: definition.id,
      text: definition.text,
      checks: definition.checks,
      status: definition.checks.every((id) => byId.get(id)?.status === 'passed') ? ('passed' as const) : ('failed' as const),
      figure: definition.figure(byId),
    }));
}

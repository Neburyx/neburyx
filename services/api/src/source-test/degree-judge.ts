import type { DegreeBasis } from '@neburyx/contracts';
import type { PlanOperator } from '../gate/types.js';

/** What the plan of a degree probe shows. The words of a plan are the server's and not a stable interface, so a plan that is not recognised is not judged. */
export interface DegreeVerdict {
  readonly result: 'cheap' | 'not-cheap' | 'could-not-tell';
  readonly basis: Extract<DegreeBasis, 'degree-operator' | 'expand' | 'unrecognized-plan' | 'no-plan'>;
}

const DEGREE_FUNCTION = 'getDegree(';
const EXPAND = 'Expand';

/** An operator that expands the relationships means the count reads them; the degree function without one means it reads the degree of the node. */
export function judgePlan(operators: readonly PlanOperator[] | null): DegreeVerdict {
  if (operators === null) return { result: 'could-not-tell', basis: 'no-plan' };
  if (operators.some((operator) => operator.name.includes(EXPAND))) return { result: 'not-cheap', basis: 'expand' };
  if (operators.some((operator) => operator.details?.includes(DEGREE_FUNCTION) === true)) return { result: 'cheap', basis: 'degree-operator' };
  return { result: 'could-not-tell', basis: 'unrecognized-plan' };
}

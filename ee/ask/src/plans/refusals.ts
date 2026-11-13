import { ExtensionRefusal } from '@neburyx/contracts';
import type { PlanRefusal } from './store.js';

/** The refusal a call that could not act on a plan gives: a plan that is not there or is another user's is not found, a plan past its time or in a state the call does not take is a conflict with its reason. */
export function refusalOfPlan(refusal: PlanRefusal): ExtensionRefusal {
  if (refusal === 'absent') return new ExtensionRefusal({ code: 'NOT_FOUND' });
  return new ExtensionRefusal({ code: 'CONFLICT', reason: refusal === 'expired' ? 'plan-expired' : 'plan-not-runnable' });
}

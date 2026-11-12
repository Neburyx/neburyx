import { z } from 'zod';
import { MAX_HOPS_CEILING } from '../mapping/budgets.js';
import type { Budgets } from './types.js';

/** The schema of a hop parameter: a whole number from 1 to the ceiling of the budget, so that a number above a template's cap is refused by the gate with the cap and not by the schema. */
export const hopsSchema = z.number().int().min(1).max(MAX_HOPS_CEILING);

/** The most hops a run may read: the lower of the template's maximum and the source's `max_hops`. */
export function hopCap(templateMax: number, budgets: Pick<Budgets, 'maxHops'>): number {
  return Math.min(templateMax, budgets.maxHops);
}

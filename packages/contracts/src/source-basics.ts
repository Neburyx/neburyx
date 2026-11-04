import { z } from 'zod';

export const SOURCE_STATES = ['connected', 'degraded', 'unavailable', 'unknown'] as const;

export const sourceStateSchema = z.enum(SOURCE_STATES);

const definitionCount = z.number().int().nonnegative();

export const mappingSummarySchema = z.strictObject({
  entityTypes: definitionCount,
  relationshipTypes: definitionCount,
  derivedRules: definitionCount,
});

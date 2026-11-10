import { z } from 'zod';
import type { MappingModel, RetentionModel } from './model.js';

export const RETENTION_DEFAULTS: RetentionModel = { deletedInvestigationsDays: 30, exportsDays: 7 };

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

const days = z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS);

export const retentionSchema = z.strictObject({
  deleted_investigations_days: days.optional(),
  exports_days: days.optional(),
});

export type RawRetention = z.infer<typeof retentionSchema>;

export function resolveRetention(raw: RawRetention | undefined): RetentionModel {
  return {
    deletedInvestigationsDays: raw?.deleted_investigations_days ?? RETENTION_DEFAULTS.deletedInvestigationsDays,
    exportsDays: raw?.exports_days ?? RETENTION_DEFAULTS.exportsDays,
  };
}

/** The retention of a mapping; a model built without a file (or by hand) has the defaults. */
export function retentionOf(mapping: MappingModel): RetentionModel {
  return mapping.retention ?? RETENTION_DEFAULTS;
}

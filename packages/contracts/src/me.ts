import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const roleSchema = z.enum(['administrator', 'investigator', 'viewer']);
export const editionSchema = z.enum(['community', 'enterprise']);
export const identityModeSchema = z.enum(['none']);

export const permittedSourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  viewSensitive: z.boolean(),
  synthetic: z.boolean(),
});

export const meResponseSchema = z.strictObject({
  principal: z.strictObject({
    id: z.string().regex(UUID_PATTERN),
    displayName: z.string().min(1),
    role: roleSchema.nullable(),
  }),
  edition: editionSchema,
  identityMode: identityModeSchema,
  sources: z.array(permittedSourceSchema),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

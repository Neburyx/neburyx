import { z } from 'zod';
import { presetProfileSchema } from './profile.js';
import { PRESET_TEMPLATES, type PresetTemplate } from './mapping.js';
import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema } from './template-run.js';

const text = z.string().min(1);

/** `GET /v1/templates`: the source whose templates and presets are asked for, and nothing else. */
export const templateListQuerySchema = z.strictObject({ sourceId: text });

/** The caller-parameter schema of each template a preset can bind: the one source of the JSON Schema the list gives. */
export const TEMPLATE_PARAMS_SCHEMAS: Readonly<Record<PresetTemplate, z.ZodType>> = {
  'shared-attribute': sharedAttributeParamsSchema,
  'linked-entities': linkedEntitiesParamsSchema,
};

/** The JSON Schema of the parameters a caller sends for a template, as Zod writes it from the contract schema; a rule it cannot state is not in it, and the run route still refuses what it breaks. */
export function paramsJsonSchemaOf(template: PresetTemplate): Record<string, unknown> {
  return z.toJSONSchema(TEMPLATE_PARAMS_SCHEMAS[template], { io: 'input', unrepresentable: 'throw' });
}

export const listedTemplateSchema = z.strictObject({
  id: z.enum(PRESET_TEMPLATES),
  version: text,
  name: text,
  description: text,
  paramsSchema: z.record(z.string(), z.unknown()).meta({ description: 'A JSON Schema (draft 2020-12) of the parameters a caller sends for the template, generated from its contract schema; it states the shape, and the run route also refuses inputs it accepts.' }),
});

export const templateListResponseSchema = z.strictObject({
  sourceId: text,
  templates: z.array(listedTemplateSchema),
  presets: z.array(presetProfileSchema),
});

export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;
export type ListedTemplate = z.infer<typeof listedTemplateSchema>;

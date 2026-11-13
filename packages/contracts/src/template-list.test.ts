import { describe, expect, it } from 'vitest';
import { PRESET_TEMPLATES } from './mapping.js';
import { TEMPLATE_PARAMS_SCHEMAS, listedTemplateSchema, paramsJsonSchemaOf, templateListQuerySchema, templateListResponseSchema } from './template-list.js';

describe('the template list contract', () => {
  it('names a parameter schema for each template a pattern can bind, and writes each as a JSON Schema without a conversion failure', () => {
    expect(Object.keys(TEMPLATE_PARAMS_SCHEMAS).sort()).toEqual([...PRESET_TEMPLATES].sort());
    for (const template of PRESET_TEMPLATES) expect(paramsJsonSchemaOf(template)).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('takes the source in the query and nothing else', () => {
    expect(templateListQuerySchema.safeParse({ sourceId: 's' }).success).toBe(true);
    expect(templateListQuerySchema.safeParse({}).success).toBe(false);
    expect(templateListQuerySchema.safeParse({ sourceId: '' }).success).toBe(false);
    expect(templateListQuerySchema.safeParse({ sourceId: ['a', 'b'] }).success).toBe(false);
    expect(templateListQuerySchema.safeParse({ sourceId: 's', other: '1' }).success).toBe(false);
  });

  it('lists a template of the closed set only, with every member', () => {
    const listed = { id: 'shared-attribute', version: '1', name: 'Shared attribute', description: 'd', paramsSchema: {} };
    expect(listedTemplateSchema.safeParse(listed).success).toBe(true);
    expect(listedTemplateSchema.safeParse({ ...listed, id: 'free-form' }).success).toBe(false);
    expect(listedTemplateSchema.safeParse({ ...listed, name: '' }).success).toBe(false);
    expect(templateListResponseSchema.safeParse({ sourceId: 's', templates: [listed], presets: [] }).success).toBe(true);
    expect(templateListResponseSchema.safeParse({ sourceId: 's', templates: [listed] }).success).toBe(false);
  });
});

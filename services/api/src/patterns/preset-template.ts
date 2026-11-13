import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema } from '@neburyx/contracts';
import { LINKED_ENTITIES_ID, linkedEntitiesTemplate } from '../gate/templates/linked-entities.js';
import { SHARED_ATTRIBUTE_ID, sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';
import type { PresetModel } from '../mapping/model.js';

/** What a preset-run holds of its template: the parameters the caller may send for a preset (the starting entity is held apart, and the preset binds the types and the relationship), and the template's version. */
export function presetTemplateOf(preset: PresetModel): { readonly templateId: string; readonly version: string; readonly schema: { safeParse(input: unknown): { success: boolean } } } {
  if (preset.template === 'linked-entities') return { templateId: LINKED_ENTITIES_ID, version: linkedEntitiesTemplate.version, schema: linkedEntitiesParamsSchema.omit({ ref: true, targetType: true, via: true }) };
  return { templateId: SHARED_ATTRIBUTE_ID, version: sharedAttributeTemplate.version, schema: sharedAttributeParamsSchema.omit({ ref: true, attributeType: true, via: true }) };
}

import { PRESET_TEMPLATES, paramsJsonSchemaOf, type TemplateListResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { TemplateCatalog } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import { presetProfilesOf } from '../registry/profile.js';

export interface TemplateListService {
  list(sourceId: string): TemplateListResponse;
}

/** The templates a pattern can bind that the catalog the gate validates against has and allows for the source, and the source's own presets; it reads no source. */
export function createTemplateListService(deps: { readonly mapping: MappingModel; readonly catalog: TemplateCatalog }): TemplateListService {
  return {
    list(sourceId) {
      const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const templates = PRESET_TEMPLATES.flatMap((id) => {
        const template = deps.catalog.find(id);
        if (template === undefined || !deps.catalog.isEnabled(id, sourceId) || template.name === undefined || template.description === undefined) return [];
        return [{ id, version: template.version, name: template.name, description: template.description, paramsSchema: paramsJsonSchemaOf(id) }];
      });
      return { sourceId, templates, presets: [...presetProfilesOf(source)] };
    },
  };
}

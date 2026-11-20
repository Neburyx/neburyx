import type { ConfigureWarning, TypeDescriptions } from '@neburyx/contracts';
import { descriptionHoldsVerdict } from '@neburyx/ee-ai-runtime';

/**
 * One warning for each description the assistant will not use because it holds a word of the verdict list: it is kept out of the model's input and the panel, and a question about its type is answered as for a type with no description, which is
 * not true of it. The warning names the source, the kind of type and the type and the rule, never any text of the description, so that the operator can reword it.
 */
export function withheldDescriptionWarnings(all: Readonly<Record<string, TypeDescriptions>> | undefined): ConfigureWarning[] {
  const warnings: ConfigureWarning[] = [];
  for (const [sourceId, types] of Object.entries(all ?? {})) {
    const held = (kind: string, name: string, description: string | undefined, own: readonly string[]): void => {
      if (description !== undefined && descriptionHoldsVerdict(description, own)) {
        warnings.push({ event: 'assistant.description_withheld', message: `source "${sourceId}": the description of the ${kind} type "${name}" holds a word of the assistant's verdict list, so the assistant does not use it and answers a question about the type as if it had no description; reword the description` });
      }
    };
    for (const entity of types.entityTypes) held('entity', entity.type, entity.description, [entity.type, entity.label, entity.displayName]);
    for (const relationship of types.relationshipTypes) held('relationship', relationship.type, relationship.description, [relationship.type]);
  }
  return warnings;
}

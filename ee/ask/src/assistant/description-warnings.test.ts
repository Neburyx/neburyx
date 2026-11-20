import type { TypeDescriptions } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { withheldDescriptionWarnings } from './description-warnings.js';

const SECRET = 'proof of fraud';
const types: Record<string, TypeDescriptions> = {
  demo: {
    entityTypes: [
      { type: 'widget', label: 'Widget', displayName: 'Widget', description: 'A widget holds parts.' },
      { type: 'gadget', label: 'Gadget', displayName: 'Gadget', description: `A gadget is ${SECRET}.` },
      { type: 'gizmo', label: 'Gizmo', displayName: 'Gizmo' },
    ],
    relationshipTypes: [{ type: 'LINKS', description: `The link is ${SECRET}.` }, { type: 'USES', description: 'The first uses the second.' }],
  },
};

describe('the warning for a description the assistant will not use', () => {
  it('names the source, the kind of type and the type and the rule, once for each such description', () => {
    const warnings = withheldDescriptionWarnings(types);
    expect(warnings.map((warning) => warning.event)).toEqual(['assistant.description_withheld', 'assistant.description_withheld']);
    expect(warnings[0]?.message).toContain('source "demo": the description of the entity type "gadget"');
    expect(warnings[1]?.message).toContain('the relationship type "LINKS"');
    expect(warnings[0]?.message).toContain("verdict list");
  });

  it('holds no text of any description, whether it is withheld or not', () => {
    for (const warning of withheldDescriptionWarnings(types)) {
      expect(warning.message).not.toContain(SECRET);
      expect(warning.message).not.toContain('fraud');
      expect(warning.message).not.toContain('holds parts');
    }
  });

  it('gives none for descriptions that pass, for types with none and for a source that offers nothing', () => {
    expect(withheldDescriptionWarnings({ demo: { entityTypes: [types['demo']?.entityTypes[0] ?? { type: 'x', label: 'X', displayName: 'X' }], relationshipTypes: [] } })).toEqual([]);
    expect(withheldDescriptionWarnings(undefined)).toEqual([]);
    expect(withheldDescriptionWarnings({})).toEqual([]);
  });

  it('excuses the name of the type itself: a type named with a word of the list is not withheld for its own name', () => {
    expect(withheldDescriptionWarnings({ demo: { entityTypes: [{ type: 'fraud_case', label: 'Fraud case', displayName: 'Fraud case', description: 'A fraud case groups records.' }], relationshipTypes: [] } })).toEqual([]);
  });
});

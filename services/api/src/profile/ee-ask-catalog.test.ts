import { CATALOG } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { linkedEntitiesTemplate } from '../gate/templates/linked-entities.js';
import { sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';

const catalogDescription = (id: string): string => CATALOG.find((entry) => entry.id === id)?.description ?? '';

describe('the planner catalog and the template list', () => {
  it('state the same facts for shared-attribute: the plain question of who shares an attribute, and the chain question that belongs to derived-rule-run', () => {
    for (const fact of ['plain question', 'derived-rule-run']) {
      expect(sharedAttributeTemplate.description).toContain(fact);
      expect(catalogDescription('shared-attribute')).toContain(fact);
    }
  });

  it('state the same facts for linked-entities: one or two hops, the relationship types listed, and that a question about a shared attribute plans shared-attribute', () => {
    expect(linkedEntitiesTemplate.description).toContain('one or two hops');
    expect(catalogDescription('linked-entities')).toContain('one or two hops');
    for (const text of [linkedEntitiesTemplate.description, catalogDescription('linked-entities')]) expect(text).toContain('shared-attribute');
    expect(catalogDescription('linked-entities')).toContain('listed relationship types');
  });
});

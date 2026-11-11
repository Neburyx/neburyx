// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { EXPAND_BY_NEIGHBOR_TYPE, PANEL_TITLE } from './expand-copy.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { createMenuRegistry } from './menu-registry.js';
import { degreeCountText } from './degree-text.js';
import { SEARCH_COPY } from '../search/copy.js';
import { SEARCH_PLACEHOLDER } from '../home/copy.js';
import { DERIVED_RELATIONSHIP, EVIDENCE_PANEL_TITLE, STORED_RELATIONSHIP, TAB_EVIDENCE, TAB_PROPERTIES, TAB_SOURCE, WHY_HERE } from '../evidence/copy.js';

const root = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
const readme = root('README.md').replace(/\s+/g, ' ');

describe('the in-app steps of the README case', () => {
  it('name the expand shortcut and menu items as the web app registers them', () => {
    const keys = createKeyBindingRegistry('other');
    const menus = createMenuRegistry();
    const removeKeys = registerBuiltInKeyBindings(keys);
    const removeMenus = registerBuiltInMenuItems(menus);
    const binding = keys.view.getState().find((candidate) => candidate.id === 'expand');
    expect(binding?.keys).toEqual(['e']);
    expect(readme).toContain('press `e`');
    const labels = (menus.view.getState().get('node') ?? []).map((item) => (typeof item.label === 'string' ? item.label : ''));
    for (const label of ['Expand neighbors', EXPAND_BY_NEIGHBOR_TYPE]) {
      expect(labels).toContain(label);
      expect(readme).toContain(`"${label}"`);
    }
    expect(readme).toContain(`"${PANEL_TITLE}"`);
    removeKeys();
    removeMenus();
  });

  it('quote the evidence menu item, the panel, its tabs and the stored-relationship label as the web app has them', () => {
    for (const phrase of [WHY_HERE, EVIDENCE_PANEL_TITLE, TAB_EVIDENCE, TAB_PROPERTIES, TAB_SOURCE, STORED_RELATIONSHIP]) expect(readme).toContain(`"${phrase}"`);
    expect(readme).not.toContain(DERIVED_RELATIONSHIP);
  });

  it('quote the search steps and the count label of the stop-list device as the web app writes them', () => {
    for (const phrase of [SEARCH_PLACEHOLDER, SEARCH_COPY.searchButton, SEARCH_COPY.groupTitle, SEARCH_COPY.openInGraph]) expect(readme).toContain(`"${phrase}"`);
    const label = degreeCountText({ value: 1000, quality: 'exact', scope: 'degree:total:mapped-relationship-ends' });
    expect(label).toBe('1,000 · exact');
    expect(readme).toContain(`"${label}"`);
  });
});

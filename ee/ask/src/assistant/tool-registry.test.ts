import { ASK_TEMPLATE_IDS, type AskSourceFolder } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildPatternCatalog } from '../patterns/index.js';
import { offerOf } from '../testing/assistant-rig.js';
import { TEMPLATE_TOOL_LIST } from './tool-templates.js';
import { buildToolRegistry, type ToolRegistryInput } from './tool-registry.js';

const source: AskSourceFolder = {
  classification: { text: 'Choose the intent.', sha256: 'a'.repeat(64) },
  intents: [
    { name: 'byId', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'b'.repeat(64) } },
    { name: 'shared', parameters: ['id'], kind: 'template', template: 'shared-attribute', settings: {} },
    { name: 'gone', parameters: ['id'], kind: 'template', template: 'withdrawn-template', settings: {} },
  ],
};
const held = offerOf('11111111-1111-4111-8111-111111111111', 'Mine');
const asked = { ...offerOf('22222222-2222-4222-8222-222222222222', 'Asked'), projection: { ...held.projection, startingEntity: 'asked' as const } };
const patterns = buildPatternCatalog({ offers: [held, asked], cut: false });
const base: ToolRegistryInput = { source, patterns, viewReadable: true, templateRunnable: (template) => template === 'shared-attribute' };

describe('the registry of tools of a turn', () => {
  it('holds one tool for each intent of the folder, each saved pattern and the view, with their parameters, and no other', () => {
    const registry = buildToolRegistry(base);
    expect(registry.tools.map((tool) => [tool.kind, tool.name])).toEqual([
      ['intent', 'byId'],
      ['intent', 'shared'],
      ['intent', 'gone'],
      ...TEMPLATE_TOOL_LIST.map((template) => ['template', template.name]),
      ['pattern', 'pat_1'],
      ['pattern', 'pat_2'],
      ['view', 'view'],
    ]);
    expect(registry.tools.filter((tool) => tool.kind === 'intent').map((tool) => tool.parameters)).toEqual([['id'], ['id'], ['id']]);
    expect(registry.tools.filter((tool) => tool.kind === 'pattern').map((tool) => tool.parameters).sort()).toEqual([[], ['anchor']]);
    expect(registry.find('view')?.parameters).toEqual([]);
  });

  it('leaves out the view when it cannot be read, and the intents and patterns when the source has none', () => {
    expect(buildToolRegistry({ ...base, viewReadable: false }).find('view')).toBeUndefined();
    expect(buildToolRegistry({ source: undefined, patterns: undefined, viewReadable: false, templateRunnable: () => true }).tools).toEqual([]);
  });

  it('lists an intent whose template can no longer run as unavailable and a query intent as available', () => {
    const registry = buildToolRegistry(base);
    expect(registry.find('gone')?.available).toBe(false);
    expect(registry.find('shared')?.available).toBe(true);
    expect(registry.find('byId')?.available).toBe(true);
  });

  it('keeps the first owner of a name given twice, so a folder intent is never shadowed', () => {
    const shadowing: AskSourceFolder = { ...source, intents: [{ name: 'view', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'c'.repeat(64) } }] };
    const registry = buildToolRegistry({ ...base, source: shadowing });
    expect(registry.tools.filter((tool) => tool.name === 'view')).toHaveLength(1);
    expect(registry.find('view')?.kind).toBe('intent');
  });

  it('offers each catalog template by its id, unavailable when its manual capability is not registered, and not at all without a source', () => {
    const registry = buildToolRegistry({ ...base, templateRunnable: (template) => template !== 'shortest-paths' });
    expect(registry.tools.filter((tool) => tool.kind === 'template').map((tool) => tool.name).sort()).toEqual(ASK_TEMPLATE_IDS.slice().sort());
    expect(registry.find('shortest-paths')?.available).toBe(false);
    expect(registry.find('entity')?.available).toBe(true);
    expect(registry.find('entity')?.parameters).toEqual(['entityType', 'stableId']);
    expect(buildToolRegistry({ ...base, source: undefined }).tools.some((tool) => tool.kind === 'template')).toBe(false);
  });

  it('keeps a folder intent that is named as a template', () => {
    const named: AskSourceFolder = { ...source, intents: [{ name: 'entity', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'c'.repeat(64) } }] };
    expect(buildToolRegistry({ ...base, source: named }).find('entity')?.kind).toBe('intent');
  });

  it('has no tool that writes: every kind is a read', () => {
    expect(new Set(buildToolRegistry(base).tools.map((tool) => tool.kind))).toEqual(new Set(['intent', 'template', 'pattern', 'view']));
  });
});

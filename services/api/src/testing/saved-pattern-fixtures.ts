import type { PatternRow } from '../db/patterns-repository.js';
import { DERIVED_RULE } from './derived-fixtures.js';
import { LINKED_PRESET, linkedMappingOf } from './linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS } from './pattern-fixtures.js';
import { SHARED_PRESET } from './shared-attribute-fixtures.js';

/** A definition over the fixture mapping: a maker to the tools it uses, with a condition on the tool's kind. */
export const SAVED_DEFINITION = { anchorType: 'maker', steps: [{ relationshipTypes: ['USES_TOOL'], direction: 'out', arrivesAt: 'tool', conditions: [{ on: 'neighbor', property: 'kind', op: 'eq', value: { kind: 'text', value: 'saw' } }] }] };

interface MappingParts {
  readonly entities?: readonly Record<string, unknown>[];
  readonly relationships?: readonly Record<string, unknown>[];
  readonly derived?: readonly Record<string, unknown>[];
  readonly patterns?: readonly Record<string, unknown>[];
  readonly budgets?: Record<string, number>;
}

/** The pattern fixtures' mapping with its two presets, or the parts given. */
export const savedMappingOf = (parts: MappingParts = {}) =>
  linkedMappingOf({ entities: parts.entities ?? PATTERN_ENTITIES, relationships: parts.relationships ?? PATTERN_RELATIONSHIPS, derived: parts.derived ?? [DERIVED_RULE], patterns: parts.patterns ?? [LINKED_PRESET, SHARED_PRESET], ...(parts.budgets === undefined ? {} : { budgets: parts.budgets }) });

const NOW = '2026-03-01T10:00:00.000Z';
const common = { ownerId: 'owner-one', sourceId: 'demo', name: 'A pattern', askForStartingEntity: true, anchorEntityType: null, anchorStableId: null, visibility: 'private' as const, lastRunAt: null, createdAt: NOW, updatedAt: NOW, version: 1 };

export const definitionRow = (over: Partial<PatternRow> = {}): PatternRow => ({ ...common, id: '0192f000-0000-7000-8000-0000000000a1', kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: SAVED_DEFINITION, ...over });
export const presetRow = (over: Partial<PatternRow> = {}): PatternRow => ({ ...common, id: '0192f000-0000-7000-8000-0000000000a2', kind: 'preset-run', presetId: LINKED_PRESET.id, templateId: 'linked-entities', templateVersion: 1, params: {}, definition: null, ...over });

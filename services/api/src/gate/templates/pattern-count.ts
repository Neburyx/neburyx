import type { TemplateDefinition } from '../catalog.js';
import { normalizePatternCount } from '../normalize/pattern-count.js';
import type { Item, Row } from '../types.js';
import { patternTemplate } from './pattern.js';

export const PATTERN_COUNT_ID = 'pattern-count';

/**
 * The heavy-operation probe of the pattern run (TAS §8.1): counts the entities the run would return, reading at most the count cap plus one of them, with the run's own bounds on every step and its degree check of every middle
 * entity. It returns numbers and flags only. It is not a template a person can run (it has no name or description for a list or a planner to offer, is not in `PRESET_TEMPLATES`, and the pattern run route takes a definition,
 * never a template ID). Under Enterprise label or property policy the count must become policy-aware or `unknown` before it can reveal anything about entities a viewer may not see; the Community gate has no such policy.
 */
export const patternCountTemplate: TemplateDefinition = {
  ...patternTemplate,
  id: PATTERN_COUNT_ID,
  version: '1',
  paged: false,
  cutMeans: 'lowerBound',
  sort: undefined,
  referencePositions: undefined,
  nextPosition: undefined,
  positionFits: undefined,
  auditAction: 'pattern.count',
  name: undefined,
  description: undefined,
  pattern: { entityTypeParam: 'anchorType', stepsParam: 'steps', count: true },
  normalize: (rows: readonly Row[]): readonly Item[] => [{ ...normalizePatternCount(rows) }],
};

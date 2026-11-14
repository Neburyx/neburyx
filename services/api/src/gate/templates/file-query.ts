import type { TemplateDefinition } from '../catalog.js';
import { FILE_QUERY_ID } from '../file-query.js';
import { normalizeFileQuery } from '../normalize/file-query.js';
import type { NormalizeContext } from '../normalize/index.js';
import type { ElementRef, Item, Plan, Row } from '../types.js';
import { z } from 'zod';

const fileQueryParamsSchema = z.strictObject({ intent: z.string(), values: z.record(z.string(), z.unknown()) });

function normalize(rows: readonly Row[], _plan?: Plan, context?: NormalizeContext): readonly Item[] {
  if (context === undefined) throw new Error('a file query needs the normalize context');
  return [{ ...normalizeFileQuery(context, rows) }];
}

/**
 * Runs the query of an intent of the operator's Ask folder for a source, with the entities' values as its parameters. The text comes from the folder and is checked again here; the request holds the intent's name and
 * values only. A cut means only that there are more rows than were returned.
 */
export const fileQueryTemplate: TemplateDefinition = {
  id: FILE_QUERY_ID,
  version: '1',
  auditAction: 'ask.file_query',
  cypher: '',
  fileQuery: { intentParam: 'intent', valuesParam: 'values' },
  paramsSchema: fileQueryParamsSchema,
  scope: 'user',
  paged: false,
  cutMeans: 'lowerBound',
  entityParams: [],
  relationshipParams: [],
  refsOf: (): readonly ElementRef[] => [],
  normalize,
};

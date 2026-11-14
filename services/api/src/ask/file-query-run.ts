import { fileQueryResultSchema, type FileQueryResult } from '@neburyx/contracts';
import type { NormalizedFileQuery } from '../gate/normalize/file-query.js';
import type { FileQueryRequest, Gate, GatePage } from '../gate/types.js';
import { AppError } from '../errors.js';

const isFileQueryItem = (item: unknown): item is NormalizedFileQuery =>
  typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings) && 'rowCount' in item && typeof item.rowCount === 'number';

/** The answer of a file query as the contract describes it: the number of rows the query returned (a lower bound when the read was cut at the source's `max_page`, never exact then), and what the gate drew. */
function fileQueryResultOf(intent: string, page: GatePage): FileQueryResult {
  const [item, ...rest] = page.items;
  if (item === undefined || rest.length > 0 || !isFileQueryItem(item)) throw new AppError('INTERNAL_ERROR');
  return fileQueryResultSchema.parse({
    status: 'ok',
    intent,
    count: { quality: page.hasMore ? 'lowerBound' : 'exact', value: item.rowCount, scope: 'rows' },
    nodes: item.nodes,
    edges: item.edges,
    notices: page.hasMore ? [{ code: 'readBounded' }] : [],
    warnings: item.warnings,
  });
}

/** Runs the file query of an intent of the source's Ask folder through the gate and answers its typed result; the rate limit of the request is the caller's. */
export function createFileQueryRunner(deps: { readonly gate: Pick<Gate, 'fileQuery'> }): { run(request: FileQueryRequest): Promise<FileQueryResult> } {
  return { run: async (request) => fileQueryResultOf(request.intent, await deps.gate.fileQuery(request)) };
}

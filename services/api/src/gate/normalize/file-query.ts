import { AppError } from '../../errors.js';
import { isPlainRelationship } from './edge.js';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainNode } from './node.js';

/** A file query's rows, normalized: the nodes and edges of every row, and the number of rows the query returned. */
export interface NormalizedFileQuery extends Normalized {
  readonly rowCount: number;
}

type Row = Readonly<Record<string, unknown>>;

const refused = (): AppError => new AppError('INVALID_REQUEST', { reason: 'file-query-result' });

const isPath = (value: unknown): value is { readonly start: unknown; readonly segments: readonly { readonly relationship: unknown; readonly end: unknown }[] } =>
  typeof value === 'object' && value !== null && (value as { $type?: unknown }).$type === 'path' && Array.isArray((value as { segments?: unknown }).segments);

/** The values of one column: a list as its elements, a path as its start node, then the relationship and the node of each segment; `null` (an optional match that found nothing) as nothing. */
function partsOf(value: unknown): readonly unknown[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry: unknown) => (isPath(entry) ? [entry.start, ...entry.segments.flatMap((segment) => [segment.relationship, segment.end])] : entry === null ? [] : [entry]));
}

/**
 * The result rule of a file query: every column of every row is a node, a relationship, a list or path of them, or `null`; a node has a label of the source's mapping and a relationship a type of it. Anything else (a number,
 * text, a map, a list of anything else, a value the adapter could not convert, a node of an unmapped type) refuses the whole result, before any row is returned. The distinct nodes and relationships of the whole result
 * may not pass the source's count cap.
 */
function checkResult(context: NormalizeContext, rows: readonly Row[]): void {
  const seen = new Set<string>();
  const relationshipTypes = new Set(context.model.relationships.map((row) => row.type));
  for (const row of rows) {
    for (const column of Object.values(row)) {
      for (const part of partsOf(column)) {
        if (isPlainNode(part)) {
          if (!part.labels.some((label) => typeof label === 'string' && context.model.entitiesByLabel.has(label))) throw refused();
          seen.add(`n:${part.elementId}`);
        } else if (isPlainRelationship(part)) {
          if (!relationshipTypes.has(part.type)) throw refused();
          seen.add(`r:${part.elementId}`);
        } else throw refused();
      }
    }
  }
  // a context with no count cap is not one the gate makes: the bound is never skipped
  if (context.countCap === undefined || seen.size > context.countCap) throw refused();
}

export function normalizeFileQuery(context: NormalizeContext, rows: readonly Row[]): NormalizedFileQuery {
  checkResult(context, rows);
  return { ...normalizeRows(context, rows), rowCount: rows.length };
}

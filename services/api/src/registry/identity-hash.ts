import { createHash } from 'node:crypto';
import { canonicalText } from '../mapping/hash.js';
import type { SourceModel } from '../mapping/model.js';

export const SOURCE_CONNECTOR = 'neo4j';

export function identityHashOf(source: Pick<SourceModel, 'uri' | 'database'>): string {
  return createHash('sha256')
    .update(canonicalText({ connector: SOURCE_CONNECTOR, uri: source.uri, database: source.database }))
    .digest('hex');
}

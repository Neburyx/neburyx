import { createHash } from 'node:crypto';
import { SENSITIVE_TITLE_KEY } from '@neburyx/contracts';
import type { SourceModel } from './model.js';

/**
 * The property keys the mapping marks `pii` for each entity type of a source (the keys the gate masks when masking is asked), with the title as `SENSITIVE_TITLE_KEY` for a type whose title is built from such a key. A type with none is absent; a
 * relationship has none. Keys only: the capability gives a caller what is sensitive and never a value.
 */
export function sensitiveKeysOf(source: SourceModel | undefined): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const entity of source?.entities ?? []) {
    const keys = [...new Set([...entity.pii, ...(entity.titleUsesPii ? [SENSITIVE_TITLE_KEY] : [])])].sort();
    if (keys.length > 0) out.set(entity.type, keys);
  }
  return out;
}

/** A fingerprint of the sensitive keys of every entity type of a source (those with none included): it changes when any key is added or removed for any type, and when a type is added or removed. */
export function sensitivityVersionOf(source: SourceModel | undefined): string {
  const types = (source?.entities ?? []).map((entity) => [entity.type, [...new Set([...entity.pii, ...(entity.titleUsesPii ? [SENSITIVE_TITLE_KEY] : [])])].sort()] as const).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  return `sv1:${createHash('sha256').update(JSON.stringify(types), 'utf8').digest('hex')}`;
}

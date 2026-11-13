import { PATTERN_LIMITS, type ListedPattern, type PatternDefinition, type SavedPattern } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { isNameTaken } from './saved-copy.js';
import { anchorChange } from './saved-model.js';

type Anchor = { readonly entityType: string; readonly stableId: string };

/** The edited definition under the version the person read: the name and the visibility stay, and the starting entity is sent only when the start type or the choice to ask each time changed. */
export function saveChanges(client: ApiClient, item: ListedPattern, definition: PatternDefinition, anchor: Anchor | undefined, signal: AbortSignal | undefined): Promise<ApiResult<SavedPattern>> {
  const moved = anchorChange(item, definition, item.askForStartingEntity, anchor);
  return client.changePattern(item.id, { expectedVersion: item.version, definition, ...(moved.send ? { anchor: moved.anchor } : {}) }, signal);
}

const COPY_TRIES = 20;

/** The name of the nth copy, cut so that the whole stays within the limit of a name. */
export function copyName(name: string, copy: number): string {
  const suffix = copy === 1 ? ' (copy)' : ` (copy ${copy})`;
  return `${Array.from(name).slice(0, PATTERN_LIMITS.nameLength - suffix.length).join('').trimEnd()}${suffix}`;
}

/** The edited definition as a new private pattern named "<name> (copy)", "(copy 2)" and so on: the first name the source does not already have for the person. */
export async function saveAsCopy(client: ApiClient, sourceId: string, item: ListedPattern, definition: PatternDefinition, anchor: Anchor | undefined, signal: AbortSignal | undefined): Promise<ApiResult<SavedPattern>> {
  const held = item.askForStartingEntity || anchor === undefined ? undefined : anchor;
  let last: ApiResult<SavedPattern> | undefined;
  for (let copy = 1; copy <= COPY_TRIES; copy += 1) {
    last = await client.savePattern({ sourceId, kind: 'definition', name: copyName(item.name, copy), definition, ...(held === undefined ? {} : { anchor: held }) }, signal);
    if (last.ok || !isNameTaken(last.failure)) return last;
  }
  return last as ApiResult<SavedPattern>;
}

import type { MappingModel } from '../mapping/model.js';
import { allowlistFromMapping } from './allowlist.js';
import type { SourceAllowlist } from './types.js';

export interface AllowlistView {
  get(sourceId: string): SourceAllowlist | undefined;
}

/**
 * The allowlist of each source of a mapping, made when it is first asked for and made again when the source's `configHash` is no longer the one it was made from, so a service that holds a live mapping
 * follows a dev reload; a source the mapping no longer holds has none.
 */
export function liveAllowlists(mapping: MappingModel): AllowlistView {
  const made = new Map<string, { readonly hash: string; readonly allowlist: SourceAllowlist }>();
  return {
    get(sourceId) {
      const source = mapping.sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) return undefined;
      const held = made.get(sourceId);
      if (held?.hash === source.configHash) return held.allowlist;
      const allowlist = allowlistFromMapping(source);
      made.set(sourceId, { hash: source.configHash, allowlist });
      return allowlist;
    },
  };
}

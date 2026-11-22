import { isKnownGrouping, type Group } from './group-model.js';

export interface StoredGroup {
  readonly id: string;
  readonly by: string;
  readonly members: readonly { readonly t: string; readonly id: string }[];
  readonly collapsed?: boolean | undefined;
}

/** The groups a stored layout holds, as the view takes them: only the kinds this client knows, only members that are loaded, an entity in one group at most, and a collapsed flag that a document without it reads as expanded. Whether a grouping by a property may stand is decided by the guard of the workspace. */
export function restoredGroups(stored: readonly StoredGroup[], keyOf: (type: string, id: string) => string | undefined): Group[] {
  const taken = new Set<string>();
  return stored.flatMap((group) => {
    if (!isKnownGrouping(group.by)) return [];
    const members = group.members.flatMap((member) => {
      const key = keyOf(member.t, member.id);
      if (key === undefined || taken.has(key)) return [];
      taken.add(key);
      return [key];
    });
    return members.length === 0 ? [] : [{ id: group.id, by: group.by, members, collapsed: group.collapsed ?? false }];
  });
}

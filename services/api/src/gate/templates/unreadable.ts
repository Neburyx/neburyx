import type { Item, Row } from '../types.js';

/** What stands for a row the template cannot read: the type of each column it has, never a value, so that a check can say it could not read the answer. */
export type UnreadableRow = { readonly unreadable: Readonly<Record<string, string>> };

export function unreadableOf(row: Row): UnreadableRow {
  return { unreadable: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value])) };
}

export function isUnreadable(item: Item): item is UnreadableRow {
  return 'unreadable' in item;
}

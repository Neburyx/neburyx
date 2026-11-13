import { ASK_MAX_RESOLUTIONS, ASK_MESSAGE_MAX_LENGTH, MAX_SEARCH_TEXT_LENGTH, type AskResolution } from '@neburyx/contracts';

/** The question's own limit counts code points, as the contract does; offsets everywhere else are UTF-16 code units. */
export const codePointCount = (text: string): number => Array.from(text).length;

export const isTooLong = (text: string): boolean => codePointCount(text) > ASK_MESSAGE_MAX_LENGTH;

export const pickLimitReached = (picks: readonly AskResolution[]): boolean => picks.length >= ASK_MAX_RESOLUTIONS;

export interface Range {
  readonly start: number;
  readonly end: number;
}

/** What changed between two texts, as the one stretch that differs: the common start and the common end are kept. */
export interface Edit {
  readonly start: number;
  readonly removed: number;
  readonly inserted: number;
}

export function editBetween(before: string, after: string): Edit {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let tail = 0;
  while (tail < shortest - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1;
  return { start, removed: before.length - start - tail, inserted: after.length - start - tail };
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const isWordCharacterAt = (text: string, index: number): boolean => index >= 0 && index < text.length && WORD_CHARACTER.test(text.charAt(index));

/**
 * The range after an edit: a range that ends before the edit, or starts after what it removed, moves with the text; a range the edit touches is
 * gone (undefined), and so is one that no longer stands on its own: its text changed, or a letter or digit now sits against its start or end.
 */
export function rangeAfter(range: Range, edit: Edit, before: string, after: string): Range | undefined {
  let moved: Range;
  if (range.end <= edit.start) moved = range;
  else if (range.start >= edit.start + edit.removed) {
    const shift = edit.inserted - edit.removed;
    moved = shift === 0 ? range : { start: range.start + shift, end: range.end + shift };
  } else return undefined;
  if (after.slice(moved.start, moved.end) !== before.slice(range.start, range.end)) return undefined;
  if (isWordCharacterAt(after, moved.start - 1) || isWordCharacterAt(after, moved.end)) return undefined;
  return moved;
}

export function picksAfter(picks: readonly AskResolution[], edit: Edit, before: string, after: string): AskResolution[] {
  return picks.flatMap((pick) => {
    const moved = rangeAfter(pick, edit, before, after);
    return moved === undefined ? [] : [{ ...pick, ...moved }];
  });
}

export interface BlockedToken extends Range {
  readonly text: string;
}

export function blockedAfter(tokens: readonly BlockedToken[], edit: Edit, before: string, after: string): BlockedToken[] {
  return tokens.flatMap((token) => {
    const moved = rangeAfter(token, edit, before, after);
    return moved === undefined ? [] : [{ ...token, ...moved }];
  });
}

/** The text without the word and one space next to it (the one before, else the one after), and the edit that made it. */
export function withoutWord(text: string, word: Range): { readonly text: string; readonly edit: Edit } {
  let { start, end } = word;
  if (start > 0 && text.charAt(start - 1) === ' ') start -= 1;
  else if (text.charAt(end) === ' ') end += 1;
  return { text: `${text.slice(0, start)}${text.slice(end)}`, edit: { start, removed: end - start, inserted: 0 } };
}

const WORD_EDGE = /^[\p{L}\p{N}].*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;

/** Whether a blocked word can be sent to the server as a value to search for: it starts and ends on a letter or digit and is within the search text limit. */
export function canBeSearchValue(word: string): boolean {
  return codePointCount(word) <= MAX_SEARCH_TEXT_LENGTH && WORD_EDGE.test(word);
}

/** Replaces a pick for the same range, so one range is picked once. */
export function withPick(picks: readonly AskResolution[], pick: AskResolution): AskResolution[] {
  return [...picks.filter((held) => held.start !== pick.start || held.end !== pick.end), pick];
}

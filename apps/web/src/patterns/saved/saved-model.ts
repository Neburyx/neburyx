import { z } from 'zod';
import { PATTERN_LIMITS, type ListedPattern, type PatternDefinition, type TemplateListResponse } from '@neburyx/contracts';
import { SAVED_COPY, type Tab } from './saved-copy.js';

export const tabOf = (item: ListedPattern): Exclude<Tab, 'built-in'> => (item.ownedByYou ? 'mine' : 'shared');

/** The count of a tab from the pages read: a number when the list is whole, a lower bound while a cursor remains. */
export const countText = (rows: number, more: boolean): string => (more ? `≥ ${rows} · lower bound` : String(rows));

export const codePointsOf = (text: string): number => Array.from(text).length;

/** Whether a name can be sent: 1 to the limit once trimmed, as the server checks it. */
export const nameFits = (name: string): boolean => {
  const length = codePointsOf(name.trim());
  return length >= 1 && length <= PATTERN_LIMITS.nameLength;
};

export const visibilityText = (item: Pick<ListedPattern, 'visibility'>): string => (item.visibility === 'shared' ? SAVED_COPY.everyone : SAVED_COPY.onlyMe);

/** What kind of pattern a row is, in a line: built in this panel, or the name of the built-in pattern it was saved from. */
export function kindLineOf(item: ListedPattern, presets: readonly TemplateListResponse['presets'][number][] | undefined): string {
  if (item.kind === 'definition') return SAVED_COPY.builtInKind;
  return presets?.find((preset) => preset.id === item.presetId)?.name ?? item.presetId;
}

export const lastRunText = (item: Pick<ListedPattern, 'lastRunAt'>): string => (item.lastRunAt === null ? SAVED_COPY.notRun : `Last run ${item.lastRunAt.slice(0, 10)} UTC`);

/** Which controls a row shows: by who made it and what it is. The API decides what is allowed; this only hides what would be refused. */
export interface RowControls {
  readonly run: boolean;
  readonly rename: boolean;
  readonly copy: boolean;
  readonly delete: boolean;
  readonly share: boolean;
  readonly unshare: boolean;
  readonly change: boolean;
}

export function controlsOf(item: ListedPattern): RowControls {
  const own = item.ownedByYou;
  return { run: item.availability.status === 'available', rename: own, copy: true, delete: own, share: own && item.visibility === 'private', unshare: own && item.visibility === 'shared', change: own && item.kind === 'definition' };
}

const startTypeSchema = z.object({ anchorType: z.string() });

/** The start type a stored definition names, or nothing when it is not a definition the product reads. */
export function definitionStartType(definition: unknown): string | undefined {
  const parsed = startTypeSchema.safeParse(definition);
  return parsed.success ? parsed.data.anchorType : undefined;
}

type Anchor = { readonly entityType: string; readonly stableId: string };
export type AnchorChange = { readonly send: false } | { readonly send: true; readonly anchor: Anchor | null };

/**
 * What a change of a saved pattern says about the starting entity it holds: nothing while the start type and the choice to ask each time are as stored (the stored entity stays, loaded or not), and otherwise the entity chosen now,
 * or `null` to ask each time.
 */
export function anchorChange(stored: ListedPattern, definition: PatternDefinition, asks: boolean, chosen: Anchor | undefined): AnchorChange {
  const typeChanged = stored.kind !== 'definition' || definitionStartType(stored.definition) !== definition.anchorType;
  if (!typeChanged && asks === stored.askForStartingEntity) return { send: false };
  return { send: true, anchor: asks || chosen === undefined ? null : chosen };
}

/** Whether the person must choose a starting entity for a change: the pattern asks for one already, or its start type changed, and none is chosen. */
export const needsEntity = (stored: ListedPattern, definition: PatternDefinition): boolean => stored.askForStartingEntity || stored.kind !== 'definition' || definitionStartType(stored.definition) !== definition.anchorType;

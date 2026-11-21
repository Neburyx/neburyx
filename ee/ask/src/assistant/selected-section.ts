import { readViewKeys } from '@neburyx/contracts';
import type { AssembledText } from '../case-summary/assemble.js';
import { canonicalText } from '../questions/canonical.js';

/** The section that says which of the elements in the call's text the person has selected, by their keys there (never a title); nothing when none of them is in the text. */
export function selectedSectionOf(selection: readonly string[] | undefined, sourceId: string, assembled: AssembledText): string {
  if (selection === undefined || selection.length === 0) return '';
  const read = readViewKeys(selection, sourceId);
  if (!read.ok) return '';
  const names = new Set([...read.refs.entities, ...read.refs.edges, ...read.refs.aggregates, ...read.refs.derived].map((ref) => canonicalText(ref)));
  const keys = [...assembled.keys].filter(([, element]) => names.has(canonicalText(element.ref))).map(([key]) => key);
  return keys.length === 0 ? '' : `\n\nThe person has selected these elements in view, by key: ${keys.join(', ')}.`;
}

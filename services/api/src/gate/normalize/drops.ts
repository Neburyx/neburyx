/** Why a row was left out of the result; a row is never repaired or invented. */
export const DROP_REASONS = ['not-mapped', 'ambiguous-type', 'no-stable-id', 'end-not-shown', 'end-missing', 'no-mapping-row'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** The rows left out, by reason. `not-visible` is added by the redact stage, only when it drops a derived edge. */
export type Dropped = Record<'not-mapped' | 'ambiguous-type' | 'no-stable-id', number> & Partial<Record<'end-not-shown' | 'end-missing' | 'no-mapping-row', number>> & { 'not-visible'?: number };

export const noDrops = (): Dropped => ({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });

const REASON_TEXT: Readonly<Record<DropReason, string>> = {
  'not-mapped': "because they are not part of this source's mapping",
  'ambiguous-type': 'because their labels match more than one entity type',
  'no-stable-id': 'because they have no usable stable ID',
  'end-not-shown': 'because one of their ends was left out',
  'end-missing': 'because one of their ends was not in the result',
  'no-mapping-row': "because no relationship of the mapping joins their ends' entity types in that direction",
};

const hidden = (count: number): string[] => (count === 0 ? [] : [`${count} derived ${count === 1 ? 'edge was' : 'edges were'} left out because their ends or supports are not shown.`]);

const HIDDEN_SENTENCE = /^\d+ derived edges? (was|were) left out because their ends or supports are not shown\.$/;

/** The warnings with the sentence about hidden derived edges replaced by one for `count` edges (or removed for none); every other warning is kept as it was. */
export function withNotVisible(warnings: readonly string[], count: number): string[] {
  return [...warnings.filter((warning) => !HIDDEN_SENTENCE.test(warning)), ...hidden(count)];
}

const listed = (count: number): string[] => (count === 0 ? [] : [`${count} ${count === 1 ? 'row has' : 'rows have'} no usable stable ID, so ${count === 1 ? 'it is' : 'they are'} listed and cannot be opened or added.`]);

/**
 * One fixed sentence for each reason that occurred; a count and no value, label or ID. `unreferenced` of the `no-stable-id` rows are not left out but listed as unreferenced hits, and have a sentence
 * of their own.
 */
export function warningsOf(dropped: Dropped, unreferenced = 0): string[] {
  return DROP_REASONS.flatMap((reason) => {
    const count = (dropped[reason] ?? 0) - (reason === 'no-stable-id' ? unreferenced : 0);
    if (count <= 0) return [];
    return [`${count} ${count === 1 ? 'row was' : 'rows were'} left out ${REASON_TEXT[reason]}.`];
  })
    .concat(listed(unreferenced))
    .concat(hidden(dropped['not-visible'] ?? 0));
}

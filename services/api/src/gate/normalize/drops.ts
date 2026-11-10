/** Why a row was left out of the result; a row is never repaired or invented. */
export const DROP_REASONS = ['not-mapped', 'ambiguous-type', 'no-stable-id', 'end-not-shown', 'end-missing', 'no-mapping-row'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** The rows left out, by reason. A derived relationship the redact stage drops is not counted here: nothing of what is hidden from a person is counted for them. */
export type Dropped = Record<'not-mapped' | 'ambiguous-type' | 'no-stable-id', number> & Partial<Record<'end-not-shown' | 'end-missing' | 'no-mapping-row', number>>;

export const noDrops = (): Dropped => ({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });

const REASON_TEXT: Readonly<Record<DropReason, string>> = {
  'not-mapped': "because they are not part of this source's mapping",
  'ambiguous-type': 'because their labels match more than one entity type',
  'no-stable-id': 'because they have no usable stable ID',
  'end-not-shown': 'because one of their ends was left out',
  'end-missing': 'because one of their ends was not in the result',
  'no-mapping-row': "because no relationship of the mapping joins their ends' entity types in that direction",
};

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
    .concat(listed(unreferenced));
}

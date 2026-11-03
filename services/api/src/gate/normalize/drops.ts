/** Why a row was left out of the result; a row is never repaired or invented. */
export const DROP_REASONS = ['not-mapped', 'ambiguous-type', 'no-stable-id'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type Dropped = Record<DropReason, number>;

export const noDrops = (): Dropped => ({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });

const REASON_TEXT: Readonly<Record<DropReason, string>> = {
  'not-mapped': "because they are not part of this source's mapping",
  'ambiguous-type': 'because their labels match more than one entity type',
  'no-stable-id': 'because they have no usable stable ID',
};

/** One fixed sentence for each reason that occurred; a count and no value, label or ID. */
export function warningsOf(dropped: Dropped): string[] {
  return DROP_REASONS.flatMap((reason) => {
    const count = dropped[reason];
    if (count === 0) return [];
    return [`${count} ${count === 1 ? 'row was' : 'rows were'} left out ${REASON_TEXT[reason]}.`];
  });
}

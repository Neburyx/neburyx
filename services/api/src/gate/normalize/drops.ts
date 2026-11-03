/** Why a row was left out of the result; a row is never repaired or invented. */
export const DROP_REASONS = ['not-mapped', 'ambiguous-type', 'no-stable-id'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** The rows left out, by reason. `not-visible` is added by the redact stage, only when it drops a derived edge. */
export type Dropped = Record<DropReason, number> & { 'not-visible'?: number };

export const noDrops = (): Dropped => ({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });

const REASON_TEXT: Readonly<Record<DropReason, string>> = {
  'not-mapped': "because they are not part of this source's mapping",
  'ambiguous-type': 'because their labels match more than one entity type',
  'no-stable-id': 'because they have no usable stable ID',
};

const hidden = (count: number): string[] => (count === 0 ? [] : [`${count} derived ${count === 1 ? 'edge was' : 'edges were'} left out because their ends or supports are not shown.`]);

const HIDDEN_SENTENCE = /^\d+ derived edges? (was|were) left out because their ends or supports are not shown\.$/;

/** The warnings with the sentence about hidden derived edges replaced by one for `count` edges (or removed for none); every other warning is kept as it was. */
export function withNotVisible(warnings: readonly string[], count: number): string[] {
  return [...warnings.filter((warning) => !HIDDEN_SENTENCE.test(warning)), ...hidden(count)];
}

/** One fixed sentence for each reason that occurred; a count and no value, label or ID. */
export function warningsOf(dropped: Dropped): string[] {
  return DROP_REASONS.flatMap((reason) => {
    const count = dropped[reason];
    if (count === 0) return [];
    return [`${count} ${count === 1 ? 'row was' : 'rows were'} left out ${REASON_TEXT[reason]}.`];
  }).concat(hidden(dropped['not-visible'] ?? 0));
}

import type { Count } from '@neburyx/contracts';

/** A whole number with en-US digit grouping, written here so the words do not depend on the locale of the machine. */
export function groupedNumber(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A count as the application writes it elsewhere (`degreeCountText` in the web app, which a test compares with this): the quality beside the number, and no number for a count that has none. */
export function countWords(count: Count): string {
  if (count.value === undefined) return 'no count';
  const number = groupedNumber(count.value);
  switch (count.quality) {
    case 'exact':
      return `${number} · exact`;
    case 'estimated':
      return `~ ${number} (estimated)`;
    case 'lowerBound':
      return `≥ ${number} · lower bound`;
    case 'unknown':
      return 'no count';
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}

/** What is not yet retrieved: the total less what is shown, with the quality the total has; no number when the total has none. */
export function notYetRetrieved(total: Count, shown: number): Count {
  if (total.value === undefined) return { quality: 'unknown', scope: total.scope };
  const remaining = Math.max(0, total.value - shown);
  return { quality: total.quality, value: remaining, scope: total.scope };
}

/** The omissions line: how many are shown and how many are not yet retrieved, labelled; with no total it says only what is shown. */
export function remainderSentence(total: Count | undefined, shown: number): string {
  const shownWords = `${groupedNumber(shown)} shown`;
  if (total === undefined) return `${shownWords}.`;
  const remainder = notYetRetrieved(total, shown);
  if (remainder.value === undefined) return `${shownWords}; how many are not yet retrieved is not known.`;
  if (remainder.quality === 'lowerBound' && remainder.value === 0) return `${shownWords}; more may exist (lower bound).`;
  return `${shownWords}; ${countWords(remainder)} not yet retrieved.`;
}

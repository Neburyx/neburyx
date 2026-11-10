import { EXPORT_HIDDEN_NOTE, EXPORT_SCOPE, type Count, type ExportHeader } from '@neburyx/contracts';

export interface HeaderFacts {
  readonly source: string;
  readonly exportedAt: Date;
  readonly shown: number;
  readonly notRetrieved: Count;
  readonly maskedFields: number;
  readonly omitted: boolean;
}

/** The not-yet-retrieved part of the coverage line, with the quality label the count carries; an unknown count has no number. */
export function notRetrievedLine(count: Count): string {
  if (count.quality === 'unknown' || count.value === undefined) return 'more not yet retrieved';
  const number = count.value.toLocaleString('en-US');
  switch (count.quality) {
    case 'exact':
      return `${number} not yet retrieved (exact)`;
    case 'estimated':
      return `~${number} not yet retrieved (estimated)`;
    case 'lowerBound':
      return `≥ ${number} not yet retrieved (lower bound)`;
  }
}

export function maskingLine(maskedFields: number): string {
  return maskedFields === 0 ? 'masking: off' : `masking: ${maskedFields} critical fields masked`;
}

/** The header every export file begins with, as data and as the lines of text the dialog previews. */
export function exportHeaderOf(facts: HeaderFacts): ExportHeader {
  const exported = facts.exportedAt.toISOString();
  const lines = [
    `source: ${facts.source}`,
    `exported: ${exported}`,
    `scope: ${EXPORT_SCOPE}`,
    `coverage: ${facts.shown.toLocaleString('en-US')} shown · ${notRetrievedLine(facts.notRetrieved)}`,
    maskingLine(facts.maskedFields),
    ...(facts.omitted ? [EXPORT_HIDDEN_NOTE] : []),
  ];
  return {
    source: facts.source,
    exported,
    scope: EXPORT_SCOPE,
    coverage: { shown: facts.shown, notRetrieved: facts.notRetrieved },
    masking: facts.maskedFields === 0 ? 'off' : { maskedFields: facts.maskedFields },
    lines,
  };
}

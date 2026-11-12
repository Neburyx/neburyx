import { EXPORT_HIDDEN_NOTE, EXPORT_SCOPE, notRetrievedText, type Count, type ExportHeader } from '@neburyx/contracts';

export interface HeaderFacts {
  readonly source: string;
  readonly exportedAt: Date;
  readonly shown: number;
  readonly notRetrieved: Count;
  readonly uncounted: number;
  readonly maskedFields: number;
  readonly omitted: boolean;
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
    `coverage: ${facts.shown.toLocaleString('en-US')} shown · ${notRetrievedText(facts.notRetrieved, facts.uncounted)}`,
    maskingLine(facts.maskedFields),
    ...(facts.omitted ? [EXPORT_HIDDEN_NOTE] : []),
  ];
  return {
    source: facts.source,
    exported,
    scope: EXPORT_SCOPE,
    coverage: { shown: facts.shown, notRetrieved: facts.notRetrieved, uncounted: facts.uncounted },
    masking: facts.maskedFields === 0 ? 'off' : { maskedFields: facts.maskedFields },
    lines,
  };
}

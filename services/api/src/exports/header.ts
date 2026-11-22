import { EXPORT_HIDDEN_NOTE, EXPORT_SCOPE, exportedTimeLine, notRetrievedText, type Count, type ExportHeader } from '@neburyx/contracts';

export interface HeaderFacts {
  readonly source: string;
  readonly exportedAt: Date;
  readonly shown: number;
  readonly notRetrieved: Count;
  readonly uncounted: number;
  readonly maskedFields: number;
  /** Whether the request asked for masking. */
  readonly requested: boolean;
  readonly omitted: boolean;
}

function maskingLine(maskedFields: number, requested: boolean): string {
  if (maskedFields > 0) return `masking: ${maskedFields} critical fields masked`;
  return requested ? 'masking: on · 0 fields masked' : 'masking: off';
}

/** The header every export file begins with, as data and as the lines of text the dialog previews. */
export function exportHeaderOf(facts: HeaderFacts): ExportHeader {
  const exported = facts.exportedAt.toISOString();
  const lines = [
    `source: ${facts.source}`,
    exportedTimeLine(facts.exportedAt),
    `scope: ${EXPORT_SCOPE}`,
    `coverage: ${facts.shown.toLocaleString('en-US')} shown · ${notRetrievedText(facts.notRetrieved, facts.uncounted)}`,
    maskingLine(facts.maskedFields, facts.requested),
    ...(facts.omitted ? [EXPORT_HIDDEN_NOTE] : []),
  ];
  return {
    source: facts.source,
    exported,
    scope: EXPORT_SCOPE,
    coverage: { shown: facts.shown, notRetrieved: facts.notRetrieved, uncounted: facts.uncounted },
    masking: facts.maskedFields === 0 && !facts.requested ? 'off' : { maskedFields: facts.maskedFields },
    lines,
  };
}

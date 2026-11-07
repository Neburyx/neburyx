import type { SourceSummary } from '@neburyx/contracts';

export interface DemoCaseEntry {
  readonly sourceId: string;
  readonly alias: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly caseRef: string;
}

/** The sources that offer a demo case, in the order the sources answer lists them; a source's state does not matter, because a failure belongs to the ordinary open. */
export function demoCasesOf(sources: readonly SourceSummary[]): readonly DemoCaseEntry[] {
  return sources.flatMap((source) => (source.synthetic && source.demoCase !== null ? [{ sourceId: source.id, alias: source.alias, ...source.demoCase }] : []));
}

/** The label of an action for a demo case: the alias follows only when several sources offer one, so no action opens a source silently. */
export function demoCaseLabel(label: string, entry: DemoCaseEntry, offered: number): string {
  return offered > 1 ? `${label} · ${entry.alias}` : label;
}

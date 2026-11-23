import type { RepeatFile } from './driver.js';
import { gateEvidenceOf, type GateEvidence } from './gate-evidence.js';
import { citedLinesOf, linesOfAnswer } from './lines.js';
import { readTurnRecords, settingsDisagreements, type Db, type TurnRecords, type Waiting } from './records.js';

/** What a turn's records show about its citations and its reads, kept with the turn so that nothing is worked out again, or lost, when the blind sets and the report are made. */
interface TurnEvidence {
  readonly citations: { readonly callNumber: number | null; readonly mapped: readonly (readonly [string, string])[]; readonly missing: readonly string[]; readonly malformed: number };
  readonly gate: GateEvidence;
}

export interface EnrichedRepeat {
  readonly file: RepeatFile;
  /** The records of each turn that has a trace id, in the order of the turns; a turn with no trace id has none. */
  readonly records: readonly (TurnRecords | undefined)[];
  readonly evidence: readonly (TurnEvidence | undefined)[];
  /** True when the settings of the runs of the repeat differ from one turn to another: the repeat is not one measurement. */
  readonly inconsistent: boolean;
  readonly disagreeing: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const readsOf = (answer: unknown): number => (isRecord(answer) && Array.isArray(answer['reads']) ? answer['reads'].length : 0);

function evidenceOf(records: TurnRecords, answer: unknown, sourceId: string, allowedTools: readonly string[], withoutGate: readonly string[]): TurnEvidence {
  const lines = linesOfAnswer(records);
  const cited = citedLinesOf(answer, lines);
  return {
    citations: { callNumber: lines?.callNumber ?? null, mapped: [...cited.mapped.entries()], missing: cited.missing, malformed: cited.malformed },
    gate: gateEvidenceOf(records, { reads: readsOf(answer), sourceId }, allowedTools, withoutGate),
  };
}

/** The run file with the records of each of its turns read back by trace id, and the citation and gate evidence worked out once from them. */
export async function enrichRepeat(file: RepeatFile, db: Db, options: { readonly allowedTools: readonly string[]; readonly withoutGate: readonly string[]; readonly waiting?: Waiting }): Promise<EnrichedRepeat> {
  const records: (TurnRecords | undefined)[] = [];
  for (const turn of file.turns) records.push(turn.traceId === undefined ? undefined : await readTurnRecords(db, turn.traceId, options.waiting));
  const evidence = records.map((entry, index) => (entry === undefined ? undefined : evidenceOf(entry, file.turns[index]?.answer, file.sourceId, options.allowedTools, options.withoutGate)));
  const disagreeing = settingsDisagreements(records.flatMap((entry) => (entry === undefined ? [] : [entry])));
  return { file, records, evidence, inconsistent: disagreeing.length > 0, disagreeing };
}

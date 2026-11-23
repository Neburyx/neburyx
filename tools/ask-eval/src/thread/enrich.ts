import type { RepeatFile } from './driver.js';
import { readTurnRecords, settingsDisagreements, type Db, type TurnRecords } from './records.js';

export interface EnrichedRepeat {
  readonly file: RepeatFile;
  /** The records of each turn that has a trace id, in the order of the turns; a turn with no trace id has none. */
  readonly records: readonly (TurnRecords | undefined)[];
  /** True when the settings of the runs of the repeat differ from one turn to another: the repeat is not one measurement. */
  readonly inconsistent: boolean;
  readonly disagreeing: readonly string[];
}

/** The run file with the records of each of its turns read back by trace id. */
export async function enrichRepeat(file: RepeatFile, db: Db): Promise<EnrichedRepeat> {
  const records: (TurnRecords | undefined)[] = [];
  for (const turn of file.turns) records.push(turn.traceId === undefined ? undefined : await readTurnRecords(db, turn.traceId));
  const disagreeing = settingsDisagreements(records.flatMap((entry) => (entry === undefined ? [] : [entry])));
  return { file, records, inconsistent: disagreeing.length > 0, disagreeing };
}

import type { TurnRecords } from './records.js';

/** The lines the model was shown in the call that wrote an answer, by key: the element lines (`n1 | …`), the read lines (`s1: …`), the keys of reads (`r1: …`), the typology and the notes. */
export interface AnswerLines {
  /** The number of the call whose reply holds the `answer` tool call (the last one). */
  readonly callNumber: number;
  readonly lines: ReadonlyMap<string, string>;
}

const KEY_LINE = /^([nerastm]\d+)(?:\s*\|\s*|:\s+)(.*)$/u;
const MESSAGE_START = /^(human|ai|tool|system): /u;

/** The lines of the last tool message of a call's values: the keys are renumbered after every read, so only the latest result's keys are the ones the answer may cite. */
function lastToolLines(valuesText: string): ReadonlyMap<string, string> {
  const lines = valuesText.split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) if ((lines[index] ?? '').startsWith('tool: ')) start = index;
  const found = new Map<string, string>();
  if (start < 0) return found;
  for (let index = start; index < lines.length; index += 1) {
    const raw = index === start ? (lines[index] ?? '').slice('tool: '.length) : (lines[index] ?? '');
    if (index > start && MESSAGE_START.test(raw)) break;
    const match = KEY_LINE.exec(raw);
    const key = match?.[1];
    if (key !== undefined && match?.[2] !== undefined) found.set(key, raw);
  }
  return found;
}

const ANSWER_CALL = /"name"\s*:\s*"answer"/u;

/** The lines the answer of a turn was written from: those of the last call whose reply calls `answer`; undefined when no call did. */
export function linesOfAnswer(records: TurnRecords): AnswerLines | undefined {
  const call = [...records.calls].reverse().find((entry) => entry.replyText !== null && ANSWER_CALL.test(entry.replyText));
  return call === undefined ? undefined : { callNumber: call.number, lines: lastToolLines(call.valuesText) };
}

export interface CitedLines {
  readonly mapped: ReadonlyMap<string, string>;
  readonly missing: readonly string[];
  /** Entries of `cites` that are not a list of text keys: reported, never skipped silently. */
  readonly malformed: number;
}

/** The lines the sentences of an answer cite (`sentences[].cites`, or `table.rows[].cites`). */
export function citedLinesOf(answer: unknown, lines: AnswerLines | undefined): CitedLines {
  const keys = new Set<string>();
  let malformed = 0;
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (isRecord(answer)) {
    const collect = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        if (!isRecord(entry) || !Array.isArray(entry['cites'])) {
          malformed += 1;
          continue;
        }
        for (const key of entry['cites']) {
          if (typeof key === 'string') keys.add(key);
          else malformed += 1;
        }
      }
    };
    collect(answer['sentences']);
    if (isRecord(answer['table'])) collect(answer['table']['rows']);
  }
  const mapped = new Map<string, string>();
  const missing: string[] = [];
  for (const key of [...keys].sort()) {
    const line = lines?.lines.get(key);
    if (line === undefined) missing.push(key);
    else mapped.set(key, line);
  }
  return { mapped, missing, malformed };
}

import { z } from 'zod';
import { FAILURE_CODES, type ProviderLabel, type RecordedAnswer } from './hooks.js';
import { UsageError } from './questions.js';
import type { SourceSet } from './sets.js';

const MAX_REPLAY_BYTES = 5 * 1024 * 1024;

const answerSchema = z.union([z.strictObject({ reply: z.string() }), z.strictObject({ declined: z.literal(true) }), z.strictObject({ failure: z.enum(FAILURE_CODES as [string, ...string[]]) })]);
const replaySchema = z.strictObject({ model: z.string().min(1).optional(), note: z.string().optional(), provider: z.enum(['anthropic', 'local']).optional(), grammar: z.boolean().optional(), thinking: z.literal('off').optional(), folders: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)), answers: z.record(z.string(), answerSchema) });

export interface Replay {
  /** The model that gave the answers. A recording has one; a scripted replay has none. */
  readonly model?: string;
  /** `scripted` marks a replay generated from the expectations; a recording by a model has no note. */
  readonly note?: string;
  /** `local` for a recording made through a local server; absent for an Anthropic one. */
  readonly provider?: 'anthropic' | 'local';
  /** For a local recording: whether a json_schema grammar constrained the replies. */
  readonly grammar?: boolean;
  /** `off` for a local recording made with the model asked not to think; absent for the model's default. */
  readonly thinking?: 'off';
  /** The SHA-256 of the `classification.md` of each source the replay was recorded for. */
  readonly folders: Readonly<Record<string, string>>;
  readonly answers: Readonly<Record<string, RecordedAnswer>>;
}

export const SCRIPTED = 'scripted';

export function parseReplay(text: string): Replay {
  if (Buffer.byteLength(text) > MAX_REPLAY_BYTES) throw new UsageError('the replay is larger than 5 MiB');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError('the replay is not valid JSON');
  }
  const read = replaySchema.safeParse(data);
  if (!read.success) throw new UsageError('the replay is not in the expected form');
  return read.data as Replay;
}

export const replayOf = (replay: Replay): ReadonlyMap<string, RecordedAnswer> => new Map(Object.entries(replay.answers));

/** Refuses a replay that is not scripted and does not say which model recorded it: its answers could be any model's. */
export function requireModel(replay: Replay): void {
  if (replay.note !== SCRIPTED && replay.model === undefined) throw new UsageError('the replay does not say which model recorded it');
  if (replay.note === SCRIPTED && replay.model !== undefined) throw new UsageError('a scripted replay names no model');
}

/** Refuses a replay recorded for another classification text, and a replay that holds an answer to a question not in the set (the number is named, never the text). */
export function checkReplay(sets: readonly SourceSet[], replay: Replay): void {
  for (const set of sets) {
    const recorded = replay.folders[set.source.sourceId];
    if (recorded !== set.source.classificationSha256) throw new UsageError(`the replay was recorded for another classification text of ${set.source.sourceId}`);
  }
  const wordings = new Set(sets.flatMap((set) => set.questions.map((question) => question.wording)));
  const stray = Object.keys(replay.answers).filter((wording) => !wordings.has(wording)).length;
  if (stray > 0) throw new UsageError(`the replay holds ${stray} answer${stray === 1 ? '' : 's'} to questions that are not in the set`);
}

/** The replay in which every question gets the reply its own expectation describes: no model, for the mechanism and for CI until a recording exists. */
export function scriptedReplay(sets: readonly SourceSet[]): Replay {
  const answers: Record<string, RecordedAnswer> = {};
  const folders: Record<string, string> = {};
  for (const set of sets) {
    folders[set.source.sourceId] = set.source.classificationSha256;
    for (const question of set.questions) answers[question.wording] = { reply: JSON.stringify(question.expect === 'refuse' ? { intent: null, entities: {} } : { intent: question.expect.intent, entities: question.expect.entities }) };
  }
  return { note: SCRIPTED, folders, answers };
}

/** The fields of a replay that say it was recorded through a local server and with or without a grammar; none for an Anthropic recording. */
export const replayLabelOf = (label: ProviderLabel): Pick<Replay, 'provider' | 'grammar' | 'thinking'> => (label.kind === 'local' ? { provider: 'local', grammar: label.grammar === true, ...(label.thinking === 'off' ? { thinking: 'off' as const } : {}) } : {});

/** The lines a report prints for the provider of a replay: nothing for an Anthropic or a scripted one. */
export const replayProviderLines = (replay: Replay): string[] => (replay.provider === 'local' ? [`provider: local, grammar ${replay.grammar === true ? 'on' : 'off'}`, ...(replay.thinking === 'off' ? ['thinking: off'] : [])] : []);

export const replayText = (replay: Replay): string => `${JSON.stringify(replay, null, 2)}\n`;

import { z } from 'zod';
import { UsageError } from '../questions.js';
import { isCalendarDate } from './facts.js';
import type { EnrichedRepeat } from './enrich.js';
import type { RepeatFile } from './driver.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const whole = z.number().int().min(0);
const position = z.number().int().min(1);
const bit = z.union([z.literal(0), z.literal(1)]);
const label = z.string().regex(/^[A-D]$/u);
const slot = z.strictObject({ repeat: position, turn: position, label });
const nullToUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

const score = z.strictObject({ repeat: position, turn: position, label, c1: bit, c2: bit, c3: bit, c4: bit });

const scoreFile = z.strictObject({
  scorer: z.string().min(1).max(80),
  origin: z.enum(['harness', 'ingested']),
  repeat: position,
  setSha256: sha256,
  invocations: whole.optional(),
  scores: z.array(score),
});

const keyFile = z.strictObject({
  key: z.strictObject({
    seed: z.string(),
    manifestSha256: z.string(),
    entries: z.array(z.strictObject({ repeat: position, turn: position, labels: z.record(z.string(), z.string()) })),
    sets: z.record(z.string(), sha256),
    noAnswer: z.array(z.string()),
  }),
  slots: z.array(slot),
});

const finite = z.number().finite();
const bars = z.strictObject({
  repeats: position,
  turns: position,
  run: z.union([z.literal(1), z.literal(2)]),
  baselineModel: z.string().min(1),
  threadMedian: finite.min(0),
  plans: z.strictObject({ right: whole, of: position, bar: whole }).refine((plans) => plans.right <= plans.of && plans.bar <= plans.of, { message: 'plans: the figures do not fit their denominator' }),
  refusals: z.strictObject({ refused: whole, of: position }).refine((refusals) => refusals.refused <= refusals.of, { message: 'refusals: more refused than asked' }),
  regressions: z.array(z.strictObject({ set: z.string().min(1), now: finite, baseline: finite.nullable(), baselineModel: z.string().min(1).nullable(), baselineCommit: z.string().min(1).nullable(), baselineRun: z.string().min(1).nullable() })),
});

const prices = z.strictObject({ input: finite.min(0), output: finite.min(0), cacheRead: finite.min(0), cacheWrite: finite.min(0), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isCalendarDate, { message: 'not a calendar date' }) });

const percent = finite.min(0).max(100);
const calibration = z.strictObject({
  repeat: position,
  setSha256: sha256,
  scorers: z.tuple([z.string().min(1), z.string().min(1)]),
  slots: position,
  agreement: z.strictObject({ overall: percent, c1: percent, c2: percent, c3: percent, c4: percent }),
  indicative: z.boolean(),
})
.refine((value) => Math.abs(value.agreement.overall - (value.agreement.c1 + value.agreement.c2 + value.agreement.c3 + value.agreement.c4) / 4) < 1e-6, { message: 'the overall agreement is not the mean of the four criteria' })
.refine((value) => value.indicative === value.agreement.overall < 90, { message: 'indicative does not follow from the overall agreement' });

const approval = z.strictObject({ exceptionConfirmed: z.literal(true), invocations: position, by: z.string().min(1), at: z.string().min(1) });
const ledger = z.strictObject({ used: whole });

const settings = z.strictObject({ model: z.string(), callLimit: position, configured: z.record(z.string(), z.union([z.string(), z.number()])), effort: z.string().optional(), effortSource: z.string().optional(), modelSource: z.string().optional() });
const turn = z.strictObject({
  n: position,
  message: z.string(),
  traceId: z.string().optional(),
  ms: z.number().min(0),
  httpStatus: whole,
  status: z.enum(['answered', 'refused', 'waiting', 'stopped', 'failed', 'other']),
  answer: z.unknown().optional(),
});
const repeatFile = z.strictObject({
  manifest: z.strictObject({ name: z.string(), sha256: z.string() }),
  sourceId: z.string(),
  repeat: position,
  expectedMessages: z.array(z.string()).min(1),
  arm: z.string().min(1),
  head: z.string(),
  settings,
  startedAt: z.string(),
  endedAt: z.string(),
  view: z.strictObject({ entities: whole }),
  turns: z.array(turn),
  ended: z.enum(['complete', 'waiting', 'failed', 'budget']),
  stoppedBecause: z.string().optional(),
});

const tokens = z.union([z.literal('unknown'), whole]).nullable();
const callRecord = z.strictObject({
  number: whole,
  startedAt: z.string(),
  durationMs: whole.nullable(),
  status: z.string().nullable(),
  failureKind: z.string().nullable(),
  errorClass: z.string().nullable(),
  errorCode: z.string().nullable(),
  tokensIn: whole.nullable(),
  tokensOut: whole.nullable(),
  instructionsSha256: z.string(),
  instructionsText: z.string(),
  valuesText: z.string(),
  replyText: z.string().nullable(),
  toolsOffered: z.array(z.string()).nullable(),
});
const eventRecord = z.strictObject({ action: z.string(), result: z.string(), sourceId: z.string().nullable(), tokensIn: tokens, tokensOut: tokens, cacheReadTokens: tokens, cacheWriteTokens: tokens, modelCalls: whole.nullable() });
const turnRecords = z
  .strictObject({
    traceId: z.string(),
    run: z.strictObject({ id: z.string(), outcome: z.string().nullable(), finished: z.boolean(), calls: whole, settings: z.record(z.string(), z.unknown()) }).nullish(),
    calls: z.array(callRecord),
    events: z.array(eventRecord),
    summaryCalls: whole,
    summaryUsage: z.array(z.strictObject({ number: whole, status: z.string().nullable(), tokensIn: whole.nullable(), tokensOut: whole.nullable() })),
    reconciled: z.strictObject({ counted: whole, stated: whole, agree: z.boolean() }).nullish(),
    problems: z.array(z.string()),
  })
  .transform((value) => ({ ...value, run: nullToUndefined(value.run), reconciled: nullToUndefined(value.reconciled) }));
const verdict = z.enum(['passed', 'failed', 'unverified']);
const evidence = z.strictObject({
  citations: z.strictObject({ callNumber: whole.nullable(), mapped: z.array(z.tuple([z.string(), z.string()])), missing: z.array(z.string()), malformed: whole }),
  gate: z.strictObject({
    gated: z.strictObject({ verdict, reads: whole, gateEvents: whole, failedEvents: whole }),
    called: z.strictObject({ verdict, names: z.array(z.string()), outside: z.array(z.string()), unparsed: whole }),
    offered: z.strictObject({ verdict, names: z.array(z.string()), outside: z.array(z.string()), callsWithoutNames: whole }),
  }),
});
const enriched = z
  .strictObject({
    file: repeatFile,
    records: z.array(turnRecords.nullable()),
    evidence: z.array(evidence.nullable()),
    inconsistent: z.boolean(),
    disagreeing: z.array(z.string()),
  })
  .transform((value) => ({ ...value, records: value.records.map(nullToUndefined), evidence: value.evidence.map(nullToUndefined) }));

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new UsageError(`${what} does not have the shape it should: ${first === undefined ? '' : `${first.path.join('.') || 'the file'}: ${first.message}`}`.slice(0, 160));
}

export const parseScoreList = (value: unknown): Score[] | undefined => {
  const result = z.array(score).safeParse(value);
  return result.success ? result.data : undefined;
};
export const parseIngested = (value: unknown, what: string): { readonly scores: readonly z.infer<typeof score>[] } => parsed(z.strictObject({ scores: z.array(score) }), value, what);
export const parseScoreFile = (value: unknown, what: string) => parsed(scoreFile, value, what);
export const parseKeyFile = (value: unknown, what: string) => parsed(keyFile, value, what);
export const parseBars = (value: unknown, what: string) => parsed(bars, value, what);
export const parsePrices = (value: unknown, what: string) => parsed(prices, value, what);
export const parseCalibration = (value: unknown, what: string) => parsed(calibration, value, what);
export const parseApprovalFile = (value: unknown): z.infer<typeof approval> | undefined => {
  const result = approval.safeParse(value);
  return result.success ? result.data : undefined;
};
export const parseLedger = (value: unknown, what: string): z.infer<typeof ledger> => parsed(ledger, value, what);
export const parseRepeatFile = (value: unknown, what: string): RepeatFile => parsed(repeatFile, value, what);
export const parseEnriched = (value: unknown, what: string): EnrichedRepeat => parsed(enriched, value, what);

export type Score = z.infer<typeof score>;
export type ScoreFile = z.infer<typeof scoreFile>;
export type KeyFile = z.infer<typeof keyFile>;
export type Bars = z.infer<typeof bars>;
export type Prices = z.infer<typeof prices>;
export type Calibration = z.infer<typeof calibration>;

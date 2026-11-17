import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { CaseSummarizer } from '@neburyx/contracts';
import { DEFAULT_OFFLOAD_THRESHOLD_MS, judgeSentences, type CheckedText } from '@neburyx/ee-ai-runtime';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_AI_SLOT_SHARE } from '../../../services/api/src/seams/ai-share.js';
import { makeAskFolder, removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { timeManualExpand } from './ai-load.js';
import { RECORD_PATH, percentile, readRecord, statisticsOf, type AiRuntimeRecord, type Statistics } from './ai-load.record.js';
import type { RigOptions } from './rig.js';

afterAll(removeAskFolders);

/** Set by `pnpm --filter @neburyx/concurrency-suite calibrate`; without it the calibration below runs short and writes nothing, so a run of the tests never rewrites the record. */
const CALIBRATING = process.env['NBX_AI_CALIBRATE'] !== undefined;

/** The rig's client holds at most 64 sockets, and the manual expand needs one of them, so the AI requests in flight are 48: more than the 32 slots of a source and the 2 of a person. */
const AI_REQUESTS = 48;
const READ_MS_LIST = [10, 15, 20, 25, 30, 35, 40, 45, 50];
const SHORT_READ_MS_LIST = [10, 20];
const SHARE = DEFAULT_AI_SLOT_SHARE;
/** Headroom over the measured regression of the manual expand's time, rounded up to a twentieth. */
const HEADROOM = 1.25;
const CHECK_ELEMENTS = 300;
const CHECK_SENTENCES = 30;
const CHECK_RUNS = 200;
const OFFLOAD_STEP_MS = 5;
const OFFLOAD_FACTOR = 4;

const SUMMARIZER: CaseSummarizer = {
  maxElements: 300,
  availability: () => ({ available: true }),
  summarize: async () => ({ status: 'ok', sentences: [], citations: [], coverage: { retrieval: '0 shown', summary: 'none' }, removedCount: 0, sent: '', model: 'm', calls: 1, summaryToken: 'v1.x' }),
};

const INTENTS = { nodeById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'node_a', stableId: '$id' } } } };

/** The real enterprise extension, configured as an operator would, with a stub summarizer and a stub classifier in place of the model: the reads of an Ask question and of a summary click are the real ones. */
async function aiLoadOptions(): Promise<RigOptions> {
  const extension = createEnterpriseExtension();
  const configured = await extension.configure?.({ preview: true }, { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: makeAskFolder(['demo'], INTENTS) }, { sourceIds: ['demo'] });
  if (configured?.ok !== true) throw new Error('the extension of the AI load could not be configured');
  return { extension, caseSummarizer: SUMMARIZER, askClassifier: { availability: () => ({ available: true }), classify: async () => ({ ok: true, intent: 'nodeById', entities: { id: 'H-1' } }) } };
}

function checkTimeP95(): number {
  const lines = Array.from({ length: CHECK_ELEMENTS }, (_, index) => `n${index + 1} | "widget" | title: "Ana Silva ${index + 1}" | id: W-${index + 1}`);
  const text: CheckedText = {
    text: lines.join('\n'),
    keys: new Map(lines.map((_, index) => [`n${index + 1}`, true])),
    lines: new Map(lines.map((line, index) => [`n${index + 1}`, line])),
    inexactCounts: [],
    unknownCountKeys: new Set(),
  };
  const sentences = Array.from({ length: CHECK_SENTENCES }, (_, index) => ({ text: `Ana Silva ${index + 1} is listed with W-${index + 1}.`, cites: [`n${index + 1}`, `n${index + 2}`] }));
  const times: number[] = [];
  for (let run = 0; run < CHECK_RUNS; run += 1) {
    const started = performance.now();
    judgeSentences(sentences, text);
    times.push(performance.now() - started);
  }
  return percentile(times, 0.95);
}

/** The calibration: times the manual expand alone, with the AI requests under the share and with the share off, for each source read time, and the shared check on the largest view. */
async function calibrate(options: RigOptions, readMsList: readonly number[]): Promise<AiRuntimeRecord> {
  const alone: number[] = [];
  const withAi: number[] = [];
  const withoutShare: number[] = [];
  const ratios: number[] = [];
  for (const readMs of readMsList) {
    const base = (await timeManualExpand(options, { aiRequests: 0, readMs })).expandMs;
    const shared = (await timeManualExpand(options, { aiRequests: AI_REQUESTS, readMs, aiShare: SHARE })).expandMs;
    alone.push(base);
    withAi.push(shared);
    withoutShare.push((await timeManualExpand(options, { aiRequests: AI_REQUESTS, readMs })).expandMs);
    ratios.push(shared / base);
  }
  const checkP95 = checkTimeP95();
  return {
    workload: { aiRequests: AI_REQUESTS, readMsList, repetitions: readMsList.length },
    share: SHARE,
    alone: statisticsOf(alone),
    withAiRequests: statisticsOf(withAi),
    withoutShare: statisticsOf(withoutShare),
    margin: { ratio: Math.ceil((percentile(ratios, 0.95) * HEADROOM) / 0.05) * 0.05 },
    offload: { thresholdMs: Math.max(OFFLOAD_STEP_MS, Math.ceil((checkP95 * OFFLOAD_FACTOR) / OFFLOAD_STEP_MS) * OFFLOAD_STEP_MS), measuredP95Ms: Math.round(checkP95 * 1000) / 1000 },
  };
}

describe('the calibration of the AI runtime', () => {
  it.runIf(CALIBRATING)('records the workload, the margin and the offload threshold from a full run', async () => {
    const record = await calibrate(await aiLoadOptions(), READ_MS_LIST);
    expect(record.withAiRequests.p95Ms).toBeLessThanOrEqual(record.alone.p95Ms * record.margin.ratio);
    writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  });

  it('gives a record from a short run that holds the share to its margin and shows the share off to be slower', async () => {
    const record = await calibrate(await aiLoadOptions(), SHORT_READ_MS_LIST);
    expect(record.workload).toMatchObject({ aiRequests: AI_REQUESTS, repetitions: SHORT_READ_MS_LIST.length });
    expect(record.withAiRequests.p95Ms).toBeLessThanOrEqual(record.alone.p95Ms * record.margin.ratio);
    expect(record.withoutShare.p95Ms).toBeGreaterThan(record.alone.p95Ms * record.margin.ratio);
    expect(record.offload.thresholdMs).toBeGreaterThanOrEqual(OFFLOAD_STEP_MS);
  });
});

describe.skipIf(CALIBRATING)('a manual expand beside AI requests', () => {
  const within = (record: AiRuntimeRecord, statistics: Statistics, alone: Statistics): boolean => statistics.medianMs <= alone.medianMs * record.margin.ratio && statistics.p95Ms <= alone.p95Ms * record.margin.ratio;

  async function measured(record: AiRuntimeRecord, aiShare: number | undefined): Promise<{ alone: Statistics; withAi: Statistics }> {
    const options = await aiLoadOptions();
    const alone: number[] = [];
    const withAi: number[] = [];
    for (const readMs of record.workload.readMsList) {
      alone.push((await timeManualExpand(options, { aiRequests: 0, readMs })).expandMs);
      withAi.push((await timeManualExpand(options, { aiRequests: record.workload.aiRequests, readMs, ...(aiShare === undefined ? {} : { aiShare }) })).expandMs);
    }
    return { alone: statisticsOf(alone), withAi: statisticsOf(withAi) };
  }

  it('stays within the recorded margin of its time alone, in the median and the 95th percentile, with the recorded number of AI requests running', async () => {
    const record = readRecord();
    const { alone, withAi } = await measured(record, record.share);
    expect(within(record, withAi, alone)).toBe(true);
  });

  it('is caught when the share is off: the same run goes over the margin', async () => {
    const record = readRecord();
    const { alone, withAi } = await measured(record, undefined);
    expect(within(record, withAi, alone)).toBe(false);
  });

  it('has the recorded figures as the defaults of the share and of the offload threshold', () => {
    const record = readRecord();
    expect(record.share).toBe(DEFAULT_AI_SLOT_SHARE);
    expect(record.offload.thresholdMs).toBe(DEFAULT_OFFLOAD_THRESHOLD_MS);
  });
});

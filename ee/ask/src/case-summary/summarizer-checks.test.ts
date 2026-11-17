import type { AuditEvent, CaseSummaryInput, GraphNode } from '@neburyx/contracts';
import { createAuditedModelCall, promptRecordOf, type CheckRunner, type ModelProvider } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';
import { buildSummaryInstructions } from './instructions.js';
import { createMemorySummaryRunStore } from './run-store.js';
import type { SummarySettings } from './settings.js';
import { SUMMARY_CLOSING_ACTION, SummaryHandled, createCaseSummarizer } from './summarizer.js';

const KEYS = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 7) } };
const settings: SummarySettings = { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 2, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 100_000, retentionDays: 30 };
const GOOD = JSON.stringify({ sentences: [{ text: 'A fixed sentence.', cites: ['n1'] }] });
const node: GraphNode = { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, display: { title: 'Ana Silva', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const input: CaseSummaryInput = {
  actorId: 'a',
  actorRole: 'investigator',
  traceId: 't',
  policyVersion: 'p1',
  request: { investigationId: '0192f000-0000-7000-8000-000000000042', sourceId: 'demo', entities: [], edges: [], aggregates: [], derived: [] },
  reading: { nodes: [node], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 },
};

function summarizerWith(checks: CheckRunner, onCheckRefused?: (reason: string) => void) {
  const events: AuditEvent[] = [];
  const modelCalls = { made: 0 };
  const provider: ModelProvider = { complete: async (request) => (modelCalls.made++, { status: 'ok', text: GOOD, usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }) };
  const model = createAuditedModelCall({ provider, configuration: { model: 'm' }, sink: { record: async (event) => void events.push(event) } });
  const summarizer = createCaseSummarizer({ settings, instructions: buildSummaryInstructions('PROMPT', 'TYPOLOGY'), model: () => model, audit: () => ({ record: async (event) => void events.push(event) }), tokenKeys: () => KEYS, runs: () => createMemorySummaryRunStore(), availability: () => ({ available: true }), checks, ...(onCheckRefused === undefined ? {} : { onCheckRefused }) });
  return { summarizer, modelCalls, events };
}

describe('the checks of a summary through the check runner', () => {
  it('gives the runner each reply with the per-call time limit and a signal, and keeps what it returns', async () => {
    const seen: { readonly timeoutMs: number; readonly hasSignal: boolean }[] = [];
    const checks: CheckRunner = { run: async (check, value, limits) => (seen.push({ timeoutMs: limits.timeoutMs, hasSignal: limits.signal !== undefined }), { status: 'done', value: check.inline(value) }) };
    const answer = await summarizerWith(checks).summarizer.summarize(input, new AbortController().signal);
    expect(answer).toMatchObject({ status: 'ok', sentences: [{ text: 'A fixed sentence.' }] });
    expect(seen).toEqual([{ timeoutMs: settings.timeoutMs, hasSignal: true }]);
  });

  it.each(['worker-failed', 'timeout'] as const)('ends the click at once when the check of a reply is refused (%s): no second model call, the reason told, and the click closed as an error', async (reason) => {
    const checks: CheckRunner = { run: async () => ({ status: 'refused', reason }) };
    const told: string[] = [];
    const { summarizer, modelCalls, events } = summarizerWith(checks, (why) => told.push(why));
    await expect(summarizer.summarize(input, new AbortController().signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(modelCalls.made).toBe(1);
    expect(told).toEqual([reason]);
    expect(events.at(-1)).toMatchObject({ action: SUMMARY_CLOSING_ACTION, result: 'failed' });
  });

  it('tells nothing when the check was cancelled, which is not a failure to run', async () => {
    const checks: CheckRunner = { run: async () => ({ status: 'refused', reason: 'cancelled' }) };
    const told: string[] = [];
    const { summarizer } = summarizerWith(checks, (why) => told.push(why));
    await expect(summarizer.summarize(input, new AbortController().signal)).rejects.toBeInstanceOf(SummaryHandled);
    expect(told).toEqual([]);
  });
});

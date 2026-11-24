import type { AssistantThreadTurnWrite } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryAssistantRunStore } from './run-store.js';
import { createMemoryAssistantThreadStore } from './thread-store.js';

const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const turn = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({ id: crypto.randomUUID(), investigationId: INVESTIGATION, userId: PERSON, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 1, question: 'Who is connected?', maskOn: false, ...over });

function stores() {
  const runs = createMemoryAssistantRunStore({ epochOf: (investigationId, actorId) => threads.epochOf(investigationId, actorId) });
  const threads = createMemoryAssistantThreadStore({ blankRunText: (investigationId, userId) => runs.blankText(investigationId, userId) });
  return { runs, threads };
}

/** A turn as the application makes one: the count is read first, then the run is opened with it, then the calls write their text. */
async function startTurn(s: ReturnType<typeof stores>, actor: string): Promise<{ readonly epoch: number; readonly runId: string }> {
  const epoch = await s.threads.epoch(INVESTIGATION, actor);
  const runId = crypto.randomUUID();
  await s.runs.begin({ id: runId, actorId: actor, investigationId: INVESTIGATION, sourceId: 'demo', traceId: 't', startedAt: new Date(), settings: {}, threadEpoch: epoch });
  return { epoch, runId };
}
const writeCall = async (s: ReturnType<typeof stores>, runId: string, number: number): Promise<void> => {
  await s.runs.beginCall({ runId, number, startedAt: new Date(), instructionsSha256: 'h', instructionsText: 'fixed', valuesText: 'SENTINEL-VALUES' });
  await s.runs.endCall({ runId, number, status: 'answered', replyText: 'SENTINEL-REPLY', durationMs: 1 });
};
const textOf = (s: ReturnType<typeof stores>, runId: string): string => JSON.stringify(s.runs.runs.filter((run) => run.id === runId).map((run) => [run.callStarts.map((call) => call.valuesText), run.callEnds.map((call) => call.replyText)]));

describe('a turn that began before the person cleared their thread', () => {
  it('stores no turn and no text of its calls after the clear, whether the writes are late, repeated or the first of the run', async () => {
    const s = stores();
    const { epoch, runId } = await startTurn(s, PERSON);
    await writeCall(s, runId, 1);
    expect(textOf(s, runId)).toContain('SENTINEL-VALUES');
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    expect(textOf(s, runId)).not.toContain('SENTINEL');
    await writeCall(s, runId, 2);
    await writeCall(s, runId, 2);
    expect(textOf(s, runId)).not.toContain('SENTINEL');
    expect(s.runs.runs[0]?.callStarts.map((call) => call.number)).toEqual([1, 2]);
    expect(await s.threads.append(turn(), epoch)).toBe('refused');
    expect((await s.threads.read(INVESTIGATION, PERSON, 100)).turns).toHaveLength(0);
  });

  it('writes no text for a run that was begun after the clear with the count of before', async () => {
    const s = stores();
    const epoch = await s.threads.epoch(INVESTIGATION, PERSON);
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    const runId = crypto.randomUUID();
    await s.runs.begin({ id: runId, actorId: PERSON, investigationId: INVESTIGATION, sourceId: 'demo', traceId: 't', startedAt: new Date(), settings: {}, threadEpoch: epoch });
    await writeCall(s, runId, 1);
    expect(textOf(s, runId)).not.toContain('SENTINEL');
  });

  it('writes no text for a run whose turn could not read the count', async () => {
    const s = stores();
    const runId = crypto.randomUUID();
    await s.runs.begin({ id: runId, actorId: PERSON, investigationId: INVESTIGATION, sourceId: 'demo', traceId: 't', startedAt: new Date(), settings: {} });
    await writeCall(s, runId, 1);
    expect(textOf(s, runId)).not.toContain('SENTINEL');
  });

  it('leaves the turn of a second person to store as usual, with its run text', async () => {
    const s = stores();
    const first = await startTurn(s, PERSON);
    const second = await startTurn(s, OTHER);
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    await writeCall(s, second.runId, 1);
    expect(await s.threads.append(turn({ userId: OTHER }), second.epoch)).toBe('stored');
    expect(textOf(s, second.runId)).toContain('SENTINEL-VALUES');
    expect(await s.threads.append(turn(), first.epoch)).toBe('refused');
  });

  it('stores a turn made after the clear in a new thread, with no notice that a previous thread was cleared', async () => {
    const s = stores();
    await s.threads.append(turn(), 0);
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    const { epoch, runId } = await startTurn(s, PERSON);
    await writeCall(s, runId, 1);
    expect(await s.threads.append(turn(), epoch)).toBe('stored');
    const read = await s.threads.read(INVESTIGATION, PERSON, 100);
    expect([read.turns.length, read.previousThreadClearedAt]).toEqual([1, null]);
    expect(textOf(s, runId)).toContain('SENTINEL-VALUES');
  });

  it('never gives a count a turn already holds: clear then close, close then clear, and close, reopen, clear each move it up', async () => {
    const s = stores();
    const seen: number[] = [await s.threads.epoch(INVESTIGATION, PERSON)];
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    seen.push(await s.threads.epoch(INVESTIGATION, PERSON));
    s.threads.clear(INVESTIGATION);
    seen.push(await s.threads.epoch(INVESTIGATION, PERSON));
    s.threads.reopen(INVESTIGATION);
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    seen.push(await s.threads.epoch(INVESTIGATION, PERSON));
    s.threads.clear(INVESTIGATION);
    seen.push(await s.threads.epoch(INVESTIGATION, PERSON));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses the write of a turn that read the count before a close that followed a clear of the person', async () => {
    const s = stores();
    await s.threads.clearOwn(INVESTIGATION, PERSON);
    const read = await s.threads.epoch(INVESTIGATION, PERSON);
    s.threads.clear(INVESTIGATION);
    s.threads.reopen(INVESTIGATION);
    expect(await s.threads.append(turn(), read)).toBe('refused');
  });
});

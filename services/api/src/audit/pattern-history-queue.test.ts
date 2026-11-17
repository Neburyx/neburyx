import { describe, expect, it, vi } from 'vitest';
import { codeOf, DEFINITION, jsonHeaders, patternApp, type PatternApp } from '../testing/saved-pattern-rig.js';
import type { PatternEvent } from '../patterns/pattern-events.js';
import { createEventQueue } from './queue.js';

const body = { sourceId: 'demo', kind: 'definition', name: 'My ring', definition: DEFINITION };
const save = (context: PatternApp) => context.app.inject({ method: 'POST', url: '/v1/patterns', payload: JSON.stringify(body), headers: jsonHeaders });

function historyOver(write: (event: PatternEvent) => Promise<void>, queueSize = 10) {
  const lines: Record<string, unknown>[] = [];
  const queue = createEventQueue<PatternEvent>({
    sinks: [{ name: 'pattern-history', sink: { record: write } }],
    idFields: (event) => ({ action: event.action, actorId: event.actorId, sourceId: event.sourceId }),
    settings: { queueSize, retryLimit: 0, retryWaitMs: 10, writeTimeoutMs: 1000 },
    logger: { warn: (fields) => void lines.push(fields) },
  });
  return { queue, lines };
}

const readyz = async (context: PatternApp) => (await context.app.inject({ method: 'GET', url: '/readyz' })).json();

describe('the pattern history through its queue, in the Community build', () => {
  it('answers a save before the history store is released, writes the event after, and counts it through /readyz', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    const { queue } = historyOver(async (event) => (await held, void written.push(event.action)));
    const context = await patternApp({ patternHistory: queue.sink, auditCounts: queue.counts });
    const response = await save(context);
    expect(response.statusCode).toBe(201);
    expect(written).toEqual([]);
    expect((await readyz(context)).audit).toMatchObject({ queued: 1, written: 0 });
    release();
    await vi.waitFor(async () => expect((await readyz(context)).audit).toEqual({ written: 1, failed: 0, dropped: 0, queued: 0 }));
    expect(written).toEqual(['saved']);
    await context.app.close();
  });

  it('answers a save when the history store fails every write, and counts the failure without text', async () => {
    const { queue, lines } = historyOver(() => Promise.reject(new Error('history store down, CANARY')));
    const context = await patternApp({ patternHistory: queue.sink, auditCounts: queue.counts });
    expect((await save(context)).statusCode).toBe(201);
    await vi.waitFor(async () => expect((await readyz(context)).audit).toMatchObject({ failed: 1, queued: 0 }));
    expect(JSON.stringify(lines)).not.toContain('CANARY');
    expect(lines[0]).toMatchObject({ event: 'audit.event_failed', sink: 'pattern-history', action: 'saved' });
    await context.app.close();
  });

  it('answers a save when the queue is full, drops the event and counts the drop', async () => {
    const { queue } = historyOver(() => new Promise<void>(() => undefined), 1);
    const context = await patternApp({ patternHistory: queue.sink, auditCounts: queue.counts });
    expect((await save(context)).statusCode).toBe(201);
    const second = await context.app.inject({ method: 'POST', url: '/v1/patterns', payload: JSON.stringify({ ...body, name: 'Another ring' }), headers: jsonHeaders });
    expect(second.statusCode).toBe(201);
    expect(codeOf(second)).toBeUndefined();
    expect((await readyz(context)).audit).toMatchObject({ dropped: 1, queued: 1 });
    await context.app.close();
  });
});

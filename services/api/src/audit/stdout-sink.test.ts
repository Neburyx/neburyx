import type { AuditEvent } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createStdoutSink } from './stdout-sink.js';

const event = (action: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({ actorId: 'u-1', actorRole: 'investigator', action, result: 'success', traceId: 'tr-1', ...extra });
const CLOCK = () => new Date('2026-11-17T10:00:00.000Z');

function capture(fail = false) {
  const lines: string[] = [];
  return { lines, write: (text: string, done: (error?: Error | null) => void) => (lines.push(text), done(fail ? new Error('EPIPE') : null)) };
}

describe('the stdout sink', () => {
  it('writes one line of JSON for each event, with the event\'s fields and the time it was written, in the order recorded', async () => {
    const out = capture();
    const sink = createStdoutSink({ write: out.write, clock: CLOCK });
    await sink.record(event('graph.expand', { sourceId: 's-1', investigationId: 'i-1', resourceType: 'entity', resourceRef: 'widget:W-1', detail: { counts: { nodes: 2, edges: 1, missing: 0 } } as never }));
    await sink.record(event('graph.path'));
    expect(out.lines).toHaveLength(2);
    expect(out.lines.every((line) => line.endsWith('\n') && line.indexOf('\n') === line.length - 1)).toBe(true);
    expect(JSON.parse(out.lines[0] ?? '')).toEqual({ at: '2026-11-17T10:00:00.000Z', actorId: 'u-1', actorRole: 'investigator', action: 'graph.expand', result: 'success', sourceId: 's-1', investigationId: 'i-1', resourceType: 'entity', resourceRef: 'widget:W-1', traceId: 'tr-1', detail: { counts: { nodes: 2, edges: 1, missing: 0 } } });
    expect(JSON.parse(out.lines[1] ?? '').action).toBe('graph.path');
  });

  it('keeps a newline inside a value on its line, because JSON escapes it', async () => {
    const out = capture();
    await createStdoutSink({ write: out.write, clock: CLOCK }).record(event('a', { resourceRef: 'line one\nline two' }));
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.split('\n')).toHaveLength(2);
    expect(JSON.parse(out.lines[0] ?? '').resourceRef).toBe('line one\nline two');
  });

  it('refuses a detail outside the known shapes, as the store does, and writes nothing', async () => {
    const out = capture();
    await expect(createStdoutSink({ write: out.write, clock: CLOCK }).record(event('a', { detail: { prompt: 'CANARY text' } as never }))).rejects.toThrow('not one of the known shapes');
    expect(out.lines).toEqual([]);
  });

  it('fails the write, with a fixed message and no value, when standard output cannot be written', async () => {
    const out = capture(true);
    const failure = createStdoutSink({ write: out.write, clock: CLOCK }).record(event('a', { resourceRef: 'CANARY' }));
    await expect(failure).rejects.toThrow('the audit line could not be written');
    await expect(failure).rejects.not.toThrow('CANARY');
  });
});

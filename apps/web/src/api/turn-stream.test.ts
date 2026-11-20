import { describe, expect, it } from 'vitest';
import { ERROR_TABLE } from '@neburyx/contracts';
import { createApiClient } from './client.js';
import { readTurnStream, type TurnStep } from './turn-stream.js';

const REFUSAL = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: 'I can’t judge guilt or intent. I can show what the investigation connects.' };
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const STEP = (n: number, phase = 'routing', rest: Record<string, unknown> = {}) => ({ event: 'step', n, phase, ...rest });
const ANSWER = { event: 'answer', answer: REFUSAL };

const bodyOf = (...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      controller.close();
    },
  });
const read = async (body: ReadableStream<Uint8Array> | null, signal?: AbortSignal) => {
  const steps: TurnStep[] = [];
  const outcome = await readTurnStream(body, (step) => steps.push(step), signal);
  return { outcome, steps };
};

describe('the reader of a streamed turn', () => {
  it('hands each step over in order and ends with the answer exactly as the JSON route gives it', async () => {
    const { outcome, steps } = await read(bodyOf(line(STEP(1)), line(STEP(2, 'reading', { tool: 'shared', label: 'Shared', subject: 'A-1' })), line(ANSWER)));
    expect(steps).toEqual([{ n: 1, phase: 'routing' }, { n: 2, phase: 'reading', tool: 'shared', label: 'Shared', subject: 'A-1' }]);
    expect(outcome).toEqual({ kind: 'answer', answer: REFUSAL });
  });

  it('reads an error line as the failure, after steps', async () => {
    const { outcome, steps } = await read(bodyOf(line(STEP(1)), line({ event: 'error', code: 'INTERNAL_ERROR', message: 'm', traceId: 't' })));
    expect(steps).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'error', error: { code: 'INTERNAL_ERROR', traceId: 't' } });
  });

  it('reads the same lines whatever the chunking: split in a line, several lines in a chunk, and a multi-byte character cut across chunks', async () => {
    const text = `${line(STEP(1, 'reading', { tool: 'shared', subject: 'Zoë 😀' }))}${line(ANSWER)}`;
    const bytes = new TextEncoder().encode(text);
    const cut = bytes.indexOf(0xc3) + 1;
    for (const chunks of [[text], [text.slice(0, 20), text.slice(20)], [bytes.slice(0, cut), bytes.slice(cut)], Array.from(bytes, (byte) => new Uint8Array([byte]))]) {
      const { outcome, steps } = await read(bodyOf(...chunks));
      expect(steps).toEqual([{ n: 1, phase: 'reading', tool: 'shared', subject: 'Zoë 😀' }]);
      expect(outcome).toEqual({ kind: 'answer', answer: REFUSAL });
    }
  });

  it('is a broken stream, never an answer, for a line that is not JSON, one that does not fit the contract and one with a member of its own', async () => {
    for (const bad of ['not json\n', line({ event: 'step', n: 1, phase: 'thinking' }), line({ event: 'step', n: 1, phase: 'routing', text: 'hello' }), line({ event: 'answer', answer: { status: 'nope' } }), line({ event: 'unknown' })]) {
      const { outcome, steps } = await read(bodyOf(line(STEP(1)), bad, line(ANSWER)));
      expect(outcome).toEqual({ kind: 'broken' });
      expect(steps).toHaveLength(1);
    }
  });

  it('is a broken stream for a line after the last one, for no last line and for a body that is not there', async () => {
    expect((await read(bodyOf(line(ANSWER), line(STEP(2))))).outcome).toEqual({ kind: 'broken' });
    expect((await read(bodyOf(line(ANSWER), line(ANSWER)))).outcome).toEqual({ kind: 'broken' });
    expect((await read(bodyOf(line(STEP(1))))).outcome).toEqual({ kind: 'broken' });
    expect((await read(bodyOf())).outcome).toEqual({ kind: 'broken' });
    expect((await read(null)).outcome).toEqual({ kind: 'broken' });
  });

  it('refuses a line of a mebibyte or more, and bytes that are not UTF-8, without showing any of them', async () => {
    expect((await read(bodyOf(`${'x'.repeat(1_048_577)}\n`))).outcome).toEqual({ kind: 'broken' });
    expect((await read(bodyOf(new Uint8Array([0xff, 0xfe, 0x0a])))).outcome).toEqual({ kind: 'broken' });
  });

  it('keeps a hostile text as text and stops reading, with no step after, when the caller aborts', async () => {
    const hostile = await read(bodyOf(line(STEP(1, 'reading', { tool: '<img src=x onerror=alert(1)>', subject: '<b>x</b>' })), line(ANSWER)));
    expect(hostile.steps[0]).toMatchObject({ tool: '<img src=x onerror=alert(1)>', subject: '<b>x</b>' });
    const controller = new AbortController();
    controller.abort();
    const stopped = await read(bodyOf(line(STEP(1)), line(ANSWER)), controller.signal);
    expect(stopped.outcome).toEqual({ kind: 'stopped' });
    expect(stopped.steps).toEqual([]);
  });
});

describe('the assistant turn of the client, streamed', () => {
  const request = { sourceId: 'demo', investigationId: 'inv-1', message: 'hello', viewElementKeys: [] };
  const ndjson = (...chunks: string[]) => new Response(bodyOf(...chunks), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });

  it('asks for the stream, gives the steps to the listener and resolves with the answer', async () => {
    let accept: string | null = null;
    const client = createApiClient(async (_input, init) => {
      accept = new Headers(init?.headers).get('accept');
      return ndjson(line(STEP(1)), line(ANSWER));
    });
    const steps: TurnStep[] = [];
    expect(await client.assistantTurn(request, undefined, (step) => steps.push(step))).toEqual({ ok: true, value: REFUSAL });
    expect(accept).toBe('application/x-ndjson');
    expect(steps).toEqual([{ n: 1, phase: 'routing' }]);
  });

  it('asks for no stream without a listener, and reads a JSON answer as before even when it asked for one', async () => {
    let accept: string | null = 'unset';
    const plain = createApiClient(async (_input, init) => {
      accept = new Headers(init?.headers).get('accept');
      return new Response(JSON.stringify(REFUSAL), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(await plain.assistantTurn(request)).toEqual({ ok: true, value: REFUSAL });
    expect(accept).toBeNull();
    const steps: TurnStep[] = [];
    expect(await plain.assistantTurn(request, undefined, (step) => steps.push(step))).toEqual({ ok: true, value: REFUSAL });
    expect(steps).toEqual([]);
  });

  it('reads an error line as the failure of that code, and a refusal before any line as the HTTP error body', async () => {
    const streamed = createApiClient(async () => ndjson(line(STEP(1)), line({ event: 'error', code: 'INTERNAL_ERROR', message: ERROR_TABLE.INTERNAL_ERROR.message, retryable: ERROR_TABLE.INTERNAL_ERROR.retryable, traceId: 't-1' })));
    expect(await streamed.assistantTurn(request, undefined, () => undefined)).toMatchObject({ ok: false, failure: { code: 'INTERNAL_ERROR' } });
    const refused = createApiClient(async () => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: ERROR_TABLE.INTERNAL_ERROR.message, retryable: ERROR_TABLE.INTERNAL_ERROR.retryable, traceId: 't-2' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    expect(await refused.assistantTurn(request, undefined, () => undefined)).toMatchObject({ ok: false, failure: { code: 'INTERNAL_ERROR', traceId: 't-2' } });
  });

  it('is a failure, never an answer, for a stream that ends with no last line, and is aborted when the caller aborts', async () => {
    const cut = createApiClient(async () => ndjson(line(STEP(1))));
    expect(await cut.assistantTurn(request, undefined, () => undefined)).toMatchObject({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
    const controller = new AbortController();
    controller.abort();
    expect(await cut.assistantTurn(request, controller.signal, () => undefined)).toMatchObject({ ok: false, failure: { code: 'ABORTED' } });
  });
});

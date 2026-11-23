import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createCallRecorder, type AuditedCallContext } from '@neburyx/ee-ai-runtime';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { AuditedModelFailure, auditChatModel, failureCodeOf, failureDetailOf, usageOf, withoutThinking, withCacheMarkers } from './audited-model.js';

const context: AuditedCallContext = { action: 'assistant.agent', actorId: 'person-1', actorRole: 'investigator', traceId: 'trace-1', sourceId: 'source-1', investigationId: 'investigation-1' };

function sinkOf(events: AuditEvent[]): AuditSink {
  return { record: (event) => { events.push(event); return Promise.resolve(); } } as AuditSink;
}

const hookOf = (events: AuditEvent[]) => ({ recorder: createCallRecorder({ sink: sinkOf(events) }), context: () => context, promptId: 'assistant.agent', promptVersion: 1, modelRef: 'model-a' });

class UsageModel extends FakeListChatModel {
  override async _generate(): Promise<{ generations: { text: string; message: AIMessage }[] }> {
    const message = new AIMessage({ content: 'ok', usage_metadata: { input_tokens: 120, output_tokens: 7, total_tokens: 127, input_token_details: { cache_read: 100, cache_creation: 10 } } });
    return { generations: [{ text: 'ok', message }] };
  }
}

class FailingModel extends FakeListChatModel {
  constructor(private readonly failure: unknown) {
    super({ responses: ['x'] });
  }
  override async _generate(): Promise<never> {
    throw this.failure;
  }
}

describe('the audited chat model', () => {
  it('records one event for a call, with the counts the provider stated and no text', async () => {
    const events: AuditEvent[] = [];
    const model = auditChatModel(new UsageModel({ responses: ['x'] }), hookOf(events));
    await model.invoke([new SystemMessage('the fixed instructions'), new HumanMessage('a question with a value')]);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.action).toBe('assistant.agent');
    expect(event?.result).toBe('success');
    expect(JSON.stringify(event)).not.toContain('a question with a value');
    expect(JSON.stringify(event)).not.toContain('the fixed instructions');
    expect(event?.detail).toMatchObject({ ai: { modelRef: 'model-a', promptId: 'assistant.agent', promptVersion: '1', tokensIn: 10, tokensOut: 7, cacheReadTokens: 100, cacheWriteTokens: 10 } });
  });

  it('records a count the provider did not state as unknown, never zero', async () => {
    const events: AuditEvent[] = [];
    const model = auditChatModel(new FakeListChatModel({ responses: ['hello'] }), hookOf(events));
    await model.invoke([new HumanMessage('q')]);
    expect(events[0]?.detail).toMatchObject({ ai: { tokensIn: 'unknown', tokensOut: 'unknown', cacheReadTokens: 'unknown', cacheWriteTokens: 'unknown' } });
  });

  it('records a failed call and rethrows it with a product failure code', async () => {
    const events: AuditEvent[] = [];
    const model = auditChatModel(new FailingModel(Object.assign(new Error('nope'), { status: 429 })), hookOf(events));
    await expect(model.invoke([new HumanMessage('q')])).rejects.toMatchObject({ code: 'rate-limited' });
    expect(events).toHaveLength(1);
    expect(events[0]?.result).toBe('failed');
  });

  it('records the class and the code of the error of a failed call in the event, and no word of its message', async () => {
    const events: AuditEvent[] = [];
    class APIConnectionError extends Error {}
    const dropped = Object.assign(new APIConnectionError('Connection error: key sk-SECRET-VALUE'), { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) });
    const model = auditChatModel(new FailingModel(dropped), hookOf(events));
    await expect(model.invoke([new HumanMessage('q')])).rejects.toMatchObject({ code: 'unreachable' });
    expect(events[0]?.detail).toMatchObject({ ai: { failure: { errorClass: 'APIConnectionError', errorCode: 'ECONNRESET' } } });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });

  it('describes an error by its class and its status or code, and by nothing it cannot hold as a short code', () => {
    expect(failureDetailOf(Object.assign(new Error('bad request: a long message'), { status: 400 }))).toEqual({ errorClass: 'Error', errorCode: '400' });
    expect(failureDetailOf('text')).toEqual({ errorClass: 'Error' });
    expect(failureDetailOf(Object.assign(new Error('x'), { code: 'has a space and text' }))).toEqual({ errorClass: 'Error' });
  });

  it('sends the earlier replies without their thinking blocks, and keeps every other block and message as it was', () => {
    const thought = new AIMessage({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'reading' }], tool_calls: [{ name: 'view', args: {}, id: 'call-1' }] });
    const plain = new AIMessage({ content: 'no blocks' });
    const human = new HumanMessage('q');
    const [first, second, third] = withoutThinking([thought, plain, human]);
    expect(first?.content).toEqual([{ type: 'text', text: 'reading' }]);
    expect((first as AIMessage).tool_calls).toEqual(thought.tool_calls);
    expect(second).toBe(plain);
    expect(third).toBe(human);
    expect(thought.content).toHaveLength(2);
  });

  it('records a cancelled call as one failed event', async () => {
    const events: AuditEvent[] = [];
    const controller = new AbortController();
    const model = auditChatModel(new FailingModel(new Error('aborted')), hookOf(events));
    controller.abort();
    await expect(model.invoke([new HumanMessage('q')], { signal: controller.signal })).rejects.toBeInstanceOf(AuditedModelFailure);
    expect(events.map((event) => event.result)).toEqual(['failed']);
  });

  it('withholds the answer when the event cannot be built', async () => {
    const hook = { ...hookOf([]), promptId: 'not a valid prompt id !' };
    let sent = 0;
    class Counting extends FakeListChatModel {
      override async _generate(...args: Parameters<FakeListChatModel['_generate']>): ReturnType<FakeListChatModel['_generate']> {
        sent += 1;
        return super._generate(...args);
      }
    }
    const model = auditChatModel(new Counting({ responses: ['hello'] }), hook);
    await expect(model.invoke([new HumanMessage('q')])).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(sent).toBe(0);
  });

  it('does not discard the answer when the sink fails to write', async () => {
    const sink = { record: () => Promise.reject(new Error('store down')) } as unknown as AuditSink;
    const model = auditChatModel(new FakeListChatModel({ responses: ['hello'] }), { ...hookOf([]), recorder: createCallRecorder({ sink }) });
    await expect(model.invoke([new HumanMessage('q')])).resolves.toBeDefined();
  });
});

describe('usage and failure mapping', () => {
  it('reads the uncached input tokens out of the total', () => {
    expect(usageOf({ input_tokens: 50, output_tokens: 5, input_token_details: { cache_read: 40 } })).toEqual({ kind: 'known', inputTokens: 10, outputTokens: 5, cacheReadTokens: 40 });
    expect(usageOf(undefined)).toEqual({ kind: 'unknown' });
  });

  it.each([
    [{ status: 401 }, false, 'rejected'],
    [{ status: 403 }, false, 'rejected'],
    [{ status: 429 }, false, 'rate-limited'],
    [{ status: 503 }, false, 'provider-error'],
    [new Error('Request timed out: timeout'), false, 'timeout'],
    [new Error('anything'), true, 'timeout'],
    [new Error('fetch failed'), false, 'unreachable'],
  ])('maps %j to %s', (error, aborted, code) => {
    expect(failureCodeOf(error, aborted)).toBe(code);
  });
});

describe('the cache markers of a call', () => {
  it('marks the end of the system text and the last message, with the time to live asked for', () => {
    const marked = withCacheMarkers([new SystemMessage('rules'), new HumanMessage('question'), new AIMessage('reply'), new HumanMessage('next')], '1h');
    expect(marked[0]?.content).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(marked[1]?.content).toBe('question');
    expect(marked[3]?.content).toEqual([{ type: 'text', text: 'next', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(withCacheMarkers([new SystemMessage('rules')], '5m')[0]?.content).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
  });

  it('sends the marked messages to the model only when the hook asks for caching', async () => {
    const seen: unknown[] = [];
    class Spy extends FakeListChatModel {
      override async _generate(messages: Parameters<FakeListChatModel['_generate']>[0]): Promise<{ generations: { text: string; message: AIMessage }[] }> {
        seen.push(messages.map((message) => message.content));
        return { generations: [{ text: 'ok', message: new AIMessage('ok') }] };
      }
    }
    await auditChatModel(new Spy({ responses: ['x'] }), { ...hookOf([]), cache: { ttl: '5m' } }).invoke([new SystemMessage('rules'), new HumanMessage('q')]);
    await auditChatModel(new Spy({ responses: ['x'] }), hookOf([])).invoke([new SystemMessage('rules'), new HumanMessage('q')]);
    expect(JSON.stringify(seen[0])).toContain('cache_control');
    expect(JSON.stringify(seen[1])).not.toContain('cache_control');
  });
});

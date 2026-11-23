import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDeepAgent } from 'deepagents';
import { createMiddleware, tool } from 'langchain';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createCallRecorder, type AuditedCallContext } from '@neburyx/ee-ai-runtime';
import type { AuditSink } from '@neburyx/contracts';
import { auditChatModel } from './audited-model.js';
import { KNOWN_REMOVED_FRAMEWORK_TOOLS, toolListFailures } from './testing.js';
import type { AgentControl, runAgent as RunAgent } from './agent-run.js';

const ALLOWED = ['answer', 'read_view'];
const check = (over: Partial<Parameters<typeof toolListFailures>[0]>) => toolListFailures({ allowed: ALLOWED, knownRemoved: KNOWN_REMOVED_FRAMEWORK_TOOLS, assembled: [], sent: [], requireAllOnFirst: true, ...over });

/** A model that records the tools it is bound to and answers with plain text. */
class Recording extends FakeListChatModel {
  readonly bound: string[][] = [];
  constructor() {
    super({ responses: ['done'] });
  }
  override bindTools(tools: Parameters<FakeListChatModel['bindTools']>[0]): ReturnType<FakeListChatModel['bindTools']> {
    this.bound.push(tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort());
    return super.bindTools(tools);
  }
  override async _generate(_messages: BaseMessage[]): Promise<{ generations: { text: string; message: AIMessage }[] }> {
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  }
}

const readView = tool(() => 'read', { name: 'read_view', description: 'Reads the view.', schema: z.object({}) });
const answer = tool(() => 'checked', { name: 'answer', description: 'Gives the answer.', schema: z.object({ text: z.string() }) });
const context: AuditedCallContext = { action: 'assistant.agent', actorId: 'person-1', actorRole: 'investigator', traceId: 'trace-1' };
const sink = { record: () => Promise.resolve() } as unknown as AuditSink;

describe('the check of the tool lists', () => {
  it('fails on a tool that was sent and is not allowed, and names it', () => {
    expect(check({ sent: [['answer', 'delete', 'read_view']] })).toEqual(['request 1: the model was sent "delete", which is extra: it is not on the allowlist']);
  });

  it('fails on a framework tool that is assembled and is neither allowed nor known, and names it; the known ones pass', () => {
    expect(check({ assembled: [['answer', 'read_file', 'read_view', 'task', 'write_todos']] })).toEqual(['request 1: the framework assembled "write_todos", which is extra: neither allowed nor a known framework tool that is removed']);
    expect(check({ assembled: [['answer', 'read_file', 'read_view', 'task']] })).toEqual([]);
  });

  it('fails on an allowed tool that is missing from the first request, and says missing', () => {
    expect(check({ sent: [['answer']] })).toEqual(['request 1: the model was not sent "read_view", which is missing from the allowlist\'s tools']);
    expect(check({ sent: [['answer', 'read_view'], ['answer']] })).toEqual([]);
  });

  it('fails on a tool sent besides the final one on the last call, and names it', () => {
    expect(check({ sent: [['answer', 'read_view'], ['answer', 'read_view']], lastCallOnly: 'answer' })).toEqual(['request 2 (the last call): the model was sent "read_view" besides "answer", which is more than the final tool']);
    expect(check({ sent: [['answer', 'read_view'], ['answer']], lastCallOnly: 'answer' })).toEqual([]);
  });

  it('writes a tool name and the rule, never a value: a failure message holds nothing else', () => {
    expect(check({ assembled: [['SECRET-VALUE-AS-A-NAME']], sent: [['answer', 'read_view']] })).toEqual(['request 1: the framework assembled "SECRET-VALUE-AS-A-NAME", which is extra: neither allowed nor a known framework tool that is removed']);
  });
});

describe('canaries: a hole is found, by tool name', () => {
  it('(ii) a model that no profile matches is sent the framework\'s own tools, among them read_file, task and delete, and the check names them', async () => {
    const model = new Recording();
    const agent = createDeepAgent({ model, tools: [readView, answer], systemPrompt: 'rules' });
    await agent.invoke({ messages: [new HumanMessage('question')] });
    const failures = check({ sent: model.bound }).join('\n');
    for (const name of ['read_file', 'task', 'delete']) expect(failures).toContain(`"${name}"`);
  });

  it('(i) a hole in the last-call filter of runAgent is found at the sent capture: more than answer is sent, and the extra tool is named', async () => {
    const source = readFileSync(fileURLToPath(new URL('./agent-run.ts', import.meta.url)), 'utf8');
    const hole = "(lastCall ? nameOf(entry) === options.finalTool : allowed.has(nameOf(entry)))";
    expect(source).toContain(hole);
    // a copy of the module with the filter of the last call taken out; the shipped file is never changed
    const copy = fileURLToPath(new URL('./zz-hole-agent-run.ts', import.meta.url));
    writeFileSync(copy, source.replace(hole, 'true'));
    try {
      const specifier = copy;
      const mutant = (await import(/* @vite-ignore */ specifier)) as { runAgent: typeof RunAgent };
      const inner = new Recording();
      const model = auditChatModel(inner, { recorder: createCallRecorder({ sink }), context: () => context, promptId: 'assistant.agent', promptVersion: 1, modelRef: 'model-a' });
      const control: AgentControl = { stop: false, calls: 0, extra: 0, answerOnly: false };
      await mutant.runAgent({ model, system: 'rules', user: 'question', control, maxCalls: 1, finalTool: 'answer', signal: new AbortController().signal, tools: [{ name: 'read_view', description: 'x', schema: z.object({}), run: () => Promise.resolve('read') }, { name: 'answer', description: 'x', schema: z.object({ text: z.string() }), run: () => Promise.resolve('checked') }] });
      const failures = check({ sent: inner.bound, lastCallOnly: 'answer', requireAllOnFirst: false });
      expect(failures).toEqual(['request 1 (the last call): the model was sent "read_view" besides "answer", which is more than the final tool']);
    } finally {
      rmSync(copy, { force: true });
    }
  });

  it('a planted extra tool is found at the assembled capture, by name', async () => {
    const assembled: string[][] = [];
    const recorder = createMiddleware({ name: 'Recorder', wrapModelCall: (request, handler) => (assembled.push(request.tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort()), handler(request)) });
    const planted = createMiddleware({ name: 'Planted', tools: [tool(() => 'x', { name: 'planted_tool', description: 'A planted tool.', schema: z.object({}) })] });
    const agent = createDeepAgent({ model: new Recording(), tools: [readView, answer], systemPrompt: 'rules', middleware: [recorder, planted] });
    await agent.invoke({ messages: [new HumanMessage('question')] });
    expect(check({ assembled, requireAllOnFirst: false }).some((failure) => failure.includes('"planted_tool"'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDeepAgent } from 'deepagents';
import { createMiddleware, tool } from 'langchain';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { toolListFailures } from './testing.js';

const ALLOWED = ['answer', 'read_view'];
const KNOWN = ['read_file', 'task'];
const check = (over: Partial<Parameters<typeof toolListFailures>[0]>) => toolListFailures({ allowed: ALLOWED, knownRemoved: KNOWN, assembled: [], sent: [], requireAllOnFirst: true, ...over });

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
});

describe('a hole that lets framework tools reach the model', () => {
  it('is found at the sent capture, naming each tool, when a middleware offers every tool on the last call', async () => {
    const model = new Recording();
    const leaky = createMiddleware({ name: 'Leaky', wrapModelCall: (request, handler) => handler(request) });
    const agent = createDeepAgent({ model, tools: [readView, answer], systemPrompt: 'rules', middleware: [leaky] });
    await agent.invoke({ messages: [new HumanMessage('question')] });
    // no profile applies to this bare double, so the framework's own tools reach the model
    const failures = check({ sent: model.bound });
    expect(failures.length).toBeGreaterThan(0);
    for (const name of ['read_file', 'task']) expect(failures.join('\n')).toContain(`"${name}"`);
  });
});

describe('canaries of the guard of the offered tools', () => {
  const plant = (name: string) => createMiddleware({ name: 'Planted', tools: [tool(() => 'x', { name, description: 'A planted tool.', schema: z.object({}) })] });
  const recorder = (assembled: string[][]) => createMiddleware({ name: 'Recorder', wrapModelCall: (request, handler) => (assembled.push(request.tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort()), handler(request)) });

  it('a planted extra tool is found at the assembled capture, by name, with no value in the message', async () => {
    const assembled: string[][] = [];
    const agent = createDeepAgent({ model: new Recording(), tools: [readView, answer], systemPrompt: 'rules', middleware: [recorder(assembled), plant('planted_tool')] });
    await agent.invoke({ messages: [new HumanMessage('question')] });
    const failures = toolListFailures({ allowed: ALLOWED, knownRemoved: KNOWN, assembled, sent: [], requireAllOnFirst: false });
    expect(failures.some((failure) => failure.includes('"planted_tool"'))).toBe(true);
  });

  it('a default tool named delete in the assembled list is found by name (planted in the list: the framework refuses to take a second tool of that name, so a middleware cannot plant it)', () => {
    const failures = toolListFailures({ allowed: ALLOWED, knownRemoved: KNOWN, assembled: [['answer', 'delete', 'read_file', 'read_view', 'task']], sent: [], requireAllOnFirst: false });
    expect(failures).toEqual(['request 1: the framework assembled "delete", which is extra: neither allowed nor a known framework tool that is removed']);
  });

  it('a failure message holds tool names and the rule, never a value of a tool list entry other than its name', () => {
    const failures = toolListFailures({ allowed: ALLOWED, knownRemoved: KNOWN, assembled: [['SECRET-VALUE-AS-A-NAME']], sent: [['answer', 'read_view']], requireAllOnFirst: true });
    expect(failures).toEqual(['request 1: the framework assembled "SECRET-VALUE-AS-A-NAME", which is extra: neither allowed nor a known framework tool that is removed']);
  });
});


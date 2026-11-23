import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { z } from 'zod';
import { DEFAULT_TOOL_NAMES, runAgent, type AgentControl, type AgentTool } from './agent-run.js';

const reader = (log: string[]): AgentTool => ({ name: 'read_view', description: 'Reads the view.', schema: z.object({}), run: () => { log.push('read'); return Promise.resolve('1 element'); } });
const answerTool = (log: string[]): AgentTool => ({ name: 'answer', description: 'Gives the answer.', schema: z.object({ text: z.string() }), run: (args) => { log.push(`answer:${String(args['text'])}`); return Promise.resolve('Checked.'); } });
const controlOf = (): AgentControl => ({ stop: false, calls: 0, extra: 0, answerOnly: false });
const base = (control: AgentControl) => ({ system: 'rules', user: 'question', control, maxCalls: 6, finalTool: 'answer', signal: new AbortController().signal });

describe('the agent run', () => {
  it('runs the tools the model calls and offers exactly those tools, none of deepagents\' own', async () => {
    const log: string[] = [];
    const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'answer', args: { text: 'one element' } }]).respond(new AIMessage('Done.'));
    const run = await runAgent({ ...base(controlOf()), model, tools: [reader(log), answerTool(log)] });
    expect(log).toEqual(['read', 'answer:one element']);
    expect(run.called.map((entry) => entry.name)).toEqual(['read_view', 'answer']);
    expect(run.offered[0]).toEqual(['answer', 'read_view']);
    for (const request of run.offered) for (const name of DEFAULT_TOOL_NAMES) expect(request).not.toContain(name);
  });

  it('binds to the model only the tools of the run: none of the framework\'s own reaches the model, whichever way the model is wrapped', async () => {
    const log: string[] = [];
    const inner = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'answer', args: { text: 'x' } }]).respond(new AIMessage('Done.'));
    const bound: string[][] = [];
    const original = inner.bindTools.bind(inner);
    inner.bindTools = ((tools: Parameters<typeof original>[0]) => {
      bound.push(tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort());
      return original(tools);
    }) as typeof inner.bindTools; // the double only records the tools it is bound with and delegates to the original, so its type is unchanged
    await runAgent({ ...base(controlOf()), model: inner, tools: [reader(log), answerTool(log)] });
    expect(bound.length).toBeGreaterThan(0);
    for (const names of bound) {
      for (const name of DEFAULT_TOOL_NAMES) expect(names).not.toContain(name);
      expect(names.every((name) => name === 'answer' || name === 'read_view')).toBe(true);
    }
  });

  it.each(['write_file', 'task', 'ls', 'dropEverything'])('runs nothing when the model names %s, which is not a tool of the run', async (name) => {
    const log: string[] = [];
    const model = fakeModel().respondWithTools([{ name, args: {} }]).respond(new AIMessage('Done.'));
    const run = await runAgent({ ...base(controlOf()), model, tools: [reader(log), answerTool(log)] });
    expect(log).toEqual([]);
    expect(run.called).toEqual([]);
  });

  it('ends the run at once when a tool sets stop, and runs no further tool of the same response', async () => {
    const log: string[] = [];
    const control = controlOf();
    const stopper: AgentTool = { name: 'read_view', description: 'x', schema: z.object({}), run: () => { control.stop = true; return Promise.resolve('stopped'); } };
    const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }, { name: 'answer', args: { text: 'late' } }]).respond(new AIMessage('never asked'));
    await runAgent({ ...base(control), model, tools: [stopper, answerTool(log)] });
    expect(log).toEqual([]);
  });

  it('offers and runs only the final tool on the last allowed call', async () => {
    const log: string[] = [];
    const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'read_view', args: {} }, { name: 'answer', args: { text: 'x' } }]);
    const run = await runAgent({ ...base(controlOf()), maxCalls: 2, model, tools: [reader(log), answerTool(log)] });
    expect(run.modelCalls).toBe(2);
    expect(run.offered).toEqual([['answer', 'read_view'], ['answer']]);
    expect(log).toEqual(['read', 'answer:x']);
  });

  it('offers only the final tool, and runs nothing else, once a tool asks for the answer', async () => {
    const log: string[] = [];
    const control = controlOf();
    const limiter: AgentTool = { name: 'read_view', description: 'x', schema: z.object({}), run: () => { control.answerOnly = true; return Promise.resolve('limit'); } };
    const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'read_view', args: {} }, { name: 'answer', args: { text: 'x' } }]).respond(new AIMessage('Done.'));
    const run = await runAgent({ ...base(control), model, tools: [limiter, answerTool(log)] });
    expect(run.offered[1]).toEqual(['answer']);
    expect(log).toEqual(['answer:x']);
  });

  it('throws an error a tool threw, as it was, and hands nothing of it to the model', async () => {
    const failing: AgentTool = { name: 'read_view', description: 'x', schema: z.object({}), run: () => Promise.reject(new Error('the gate refused')) };
    const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respond(new AIMessage('never asked'));
    await expect(runAgent({ ...base(controlOf()), model, tools: [failing, answerTool([])] })).rejects.toThrow('the gate refused');
  });
});

describe('a call whose arguments do not fit', () => {
  it('is told so in a fixed sentence, with nothing of the framework\'s error', async () => {
    const seen: string[] = [];
    const log: string[] = [];
    const model = fakeModel()
      .respondWithTools([{ name: 'answer', args: { text: 7 } }])
      .respond((messages) => {
        seen.push(messages.map((message) => JSON.stringify(message.content)).join('\n'));
        return new AIMessage('Done.');
      });
    await runAgent({ ...base(controlOf()), model, tools: [reader(log), answerTool(log)] });
    expect(log).toEqual([]);
    expect(seen[0]).toContain('The arguments did not fit this tool');
    expect(seen[0]).not.toContain('node_modules');
  });
});

describe('a request that does not fit', () => {
  it('ends the run before the call, counts no call and reports that it refused', async () => {
    let received = 0;
    const model = fakeModel().respond(() => {
      received += 1;
      return new AIMessage('never asked');
    });
    const control = controlOf();
    const run = await runAgent({ ...base(control), model, tools: [reader([]), answerTool([])], beforeCall: () => false });
    expect(received).toBe(0);
    expect(run).toMatchObject({ refused: true, modelCalls: 0 });
    expect(control.calls).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { z } from 'zod';
import { DEFAULT_TOOL_NAMES, SUPERSEDED_TEXT, runAgent, type AgentControl, type AgentTool } from './agent-run.js';

const reader = (log: string[]): AgentTool => ({ name: 'read_view', description: 'Reads the view.', schema: z.object({}), run: () => { log.push('read'); return Promise.resolve('1 element'); } });
const answerTool = (log: string[]): AgentTool => ({ name: 'answer', description: 'Gives the answer.', schema: z.object({ text: z.string() }), run: (args) => { log.push(`answer:${String(args['text'])}`); return Promise.resolve('Checked.'); } });
const controlOf = (): AgentControl => ({ stop: false, calls: 0, extra: 0, answerOnly: false });
const base = (control: AgentControl) => ({ system: 'rules', user: 'question', control, maxCalls: 6, finalTool: 'answer', signal: new AbortController().signal });

describe('the thinking blocks of a call whose list of tools differs from the one before', () => {
  it('are taken out of the history of the last call, which offers the final tool only, and kept in a call whose list is the same (the provider bound them to the list: a recorded 400)', async () => {
    const log: string[] = [];
    const thought = (text: string) => ({ type: 'thinking', thinking: '', signature: `sig-${text}` });
    const model = fakeModel()
      .respond(new AIMessage({ content: [thought('one')], tool_calls: [{ name: 'read_view', args: {}, id: 'c1' }] }))
      .respond(new AIMessage({ content: [thought('two')], tool_calls: [{ name: 'answer', args: { text: 'x' }, id: 'c2' }] }))
      .respond(new AIMessage({ content: [thought('three')], tool_calls: [{ name: 'answer', args: { text: 'y' }, id: 'c3' }] }))
      .respond(new AIMessage('Done.'));
    const sent: { tools: string[]; thinking: number }[] = [];
    const original = model.bindTools.bind(model);
    model.bindTools = ((tools: Parameters<typeof original>[0]) => {
      const bound = original(tools);
      const names = tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort();
      const invoke = bound.invoke.bind(bound);
      bound.invoke = ((messages: Parameters<typeof invoke>[0], options?: Parameters<typeof invoke>[1]) => {
        sent.push({ tools: names, thinking: JSON.stringify(messages).split('"type":"thinking"').length - 1 });
        return invoke(messages, options);
      }) as typeof bound.invoke;
      return bound;
    }) as typeof model.bindTools; // the double only records what it is bound and invoked with and delegates to the original
    await runAgent({ ...base(controlOf()), maxCalls: 3, model, tools: [reader(log), answerTool(log)] });
    expect(sent.map((call) => call.tools)).toEqual([['answer', 'read_view'], ['answer', 'read_view'], ['answer']]);
    expect(sent.map((call) => call.thinking)).toEqual([0, 1, 0]);
  });
});

describe('a request that does not fit', () => {
  const recorded = (responses: AIMessage[]) => {
    const model = fakeModel();
    for (const response of responses) model.respond(response);
    const sent: { tools: string[]; messages: number }[] = [];
    const original = model.bindTools.bind(model);
    model.bindTools = ((tools: Parameters<typeof original>[0]) => {
      const bound = original(tools);
      const names = tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort();
      const invoke = bound.invoke.bind(bound);
      bound.invoke = ((messages: Parameters<typeof invoke>[0], options?: Parameters<typeof invoke>[1]) => {
        sent.push({ tools: names, messages: Array.isArray(messages) ? messages.length : 0 });
        return invoke(messages, options);
      }) as typeof bound.invoke;
      return bound;
    }) as typeof model.bindTools; // the double only records what it is bound and invoked with and delegates to the original
    return { model, sent };
  };
  const calling = (names: string[], id: string) => new AIMessage({ content: '', tool_calls: names.map((name, index) => ({ name, args: name === 'answer' ? { text: 'from the first read' } : {}, id: `${id}-${index}` })) });
  const stopping = (control: AgentControl, log: string[]): AgentTool => {
    const final = answerTool(log);
    return { ...final, run: (args) => ((control.stop = true), final.run(args)) };
  };

  it('is sent without the newest reads, the oldest kept, with the final tool only, and the caller is told how many reads stay before it is sent', async () => {
    const log: string[] = [];
    const { model, sent } = recorded([calling(['read_view'], 'c1'), calling(['read_view'], 'c2'), calling(['answer'], 'c3'), new AIMessage('Done.')]);
    const control = controlOf();
    const takenBack: number[] = [];
    const run = await runAgent({ ...base(control), maxCalls: 6, model, tools: [reader(log), stopping(control, log)], beforeCall: (request) => request.messages.length <= 3, onTrim: (count) => takenBack.push(count) });
    expect(run.trimmed).toBe(true);
    expect(run.refused).toBe(false);
    expect(takenBack).toEqual([1]);
    expect(sent.map((call) => call.tools)).toEqual([['answer', 'read_view'], ['answer', 'read_view'], ['answer']]);
    expect(sent.map((call) => call.messages)).toEqual([2, 4, 4]);
  });

  it('is sent whole, with the final tool only, when that alone makes it fit: no read is taken back', async () => {
    const log: string[] = [];
    const { model } = recorded([calling(['read_view'], 'c1'), calling(['read_view'], 'c2'), calling(['answer'], 'c3'), new AIMessage('Done.')]);
    const control = controlOf();
    const takenBack: number[] = [];
    const run = await runAgent({ ...base(control), maxCalls: 6, model, tools: [reader(log), stopping(control, log)], beforeCall: (request) => request.tools.split('\n').length <= 1 || request.messages.length <= 3, onTrim: (count) => takenBack.push(count) });
    expect(run.trimmed).toBe(false);
    expect(takenBack).toEqual([]);
  });

  it('tells how many reads stay whatever the reply left out held (a parallel pair, a name that did not run), counts a second trim by the same figure, and never leaves out an answer: the run ends when the newest group is the answer', async () => {
    const log: string[] = [];
    const parallel = recorded([calling(['read_view'], 'c1'), calling(['read_view', 'read_view'], 'c2'), calling(['answer'], 'c3'), new AIMessage('Done.')]);
    const control = controlOf();
    const takenBack: number[] = [];
    await runAgent({ ...base(control), maxCalls: 6, model: parallel.model, tools: [reader(log), stopping(control, log)], beforeCall: (request) => request.messages.length <= 3, onTrim: (count) => takenBack.push(count) });
    expect(takenBack).toEqual([1]);
    const mixed = recorded([calling(['read_view'], 'm1'), calling(['read_view', 'write_file'], 'm2'), calling(['answer'], 'm3'), new AIMessage('Done.')]);
    const again: number[] = [];
    const third = controlOf();
    await runAgent({ ...base(third), maxCalls: 6, model: mixed.model, tools: [reader(log), stopping(third, log)], beforeCall: (request) => request.messages.length <= 3, onTrim: (count) => again.push(count) });
    expect(again).toEqual([1]);
    const again2 = recorded([calling(['read_view'], 'd1'), calling(['read_view'], 'd2'), calling(['read_view'], 'd3'), calling(['answer'], 'd4'), new AIMessage('Done.')]);
    const retaken: number[] = [];
    const fourth = controlOf();
    await runAgent({ ...base(fourth), maxCalls: 8, model: again2.model, tools: [reader(log), stopping(fourth, log)], beforeCall: (request) => request.messages.length <= 3, onTrim: (kept) => retaken.push(kept) });
    expect(retaken.length).toBeGreaterThan(0);
    expect(new Set(retaken)).toEqual(new Set([1]));
    const answered = recorded([calling(['read_view'], 'a1'), calling(['answer'], 'a2'), calling(['answer'], 'a3'), new AIMessage('Done.')]);
    const second = await runAgent({ ...base(controlOf()), maxCalls: 6, model: answered.model, tools: [reader(log), answerTool(log)], beforeCall: (request) => request.messages.length <= 3 });
    expect(second.refused).toBe(true);
    expect(second.trimmed).toBe(false);
  });

  it('ends the run as before when not even the first read fits, and makes no call for it', async () => {
    const log: string[] = [];
    const { model, sent } = recorded([calling(['read_view'], 'c1'), calling(['answer'], 'c2'), new AIMessage('Done.')]);
    const run = await runAgent({ ...base(controlOf()), maxCalls: 6, model, tools: [reader(log), answerTool(log)], beforeCall: (request) => request.messages.length <= 1 });
    expect(run.refused).toBe(true);
    expect(run.trimmed).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe('a request that would not fit and holds earlier results the newest one repeats in full', () => {
  const calling = (name: string, id: string) => new AIMessage({ content: '', tool_calls: [{ name, args: name === 'answer' ? { text: 'x' } : {}, id }] });
  /** A run of reads that give these results in order, then an answer; what each model request held of the results, and the tools it offered. */
  const runWith = async (results: string[], fits: (results: readonly string[], tools: string) => boolean) => {
    const model = fakeModel();
    results.forEach((_result, index) => model.respond(calling('read_view', `r${index}`)));
    model.respond(calling('answer', 'a1')).respond(new AIMessage('Done.'));
    const sent: { results: string[]; tools: string[] }[] = [];
    const original = model.bindTools.bind(model);
    model.bindTools = ((tools: Parameters<typeof original>[0]) => {
      const bound = original(tools);
      const names = tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort();
      const invoke = bound.invoke.bind(bound);
      bound.invoke = ((messages: Parameters<typeof invoke>[0], options?: Parameters<typeof invoke>[1]) => {
        sent.push({ tools: names, results: (messages as { type: string; content: unknown }[]).filter((message) => message.type === 'tool').map((message) => String(message.content)) });
        return invoke(messages, options);
      }) as typeof bound.invoke;
      return bound;
    }) as typeof model.bindTools; // the double only records what it is bound and invoked with and delegates to the original
    const control = controlOf();
    const waiting = [...results];
    const read: AgentTool = { name: 'read_view', description: 'Reads.', schema: z.object({}), run: () => Promise.resolve(waiting.shift() ?? '') };
    const final = answerTool([]);
    const takenBack: number[] = [];
    const run = await runAgent({ ...base(control), maxCalls: 8, model, tools: [read, { ...final, run: (args) => ((control.stop = true), final.run(args)) }], beforeCall: (request) => fits(request.messages.slice(1).filter((text) => text !== ''), request.tools), onTrim: (kept) => takenBack.push(kept) });
    return { run, sent, takenBack };
  };
  const size = (messages: readonly string[]): number => messages.join('').length;
  const line = (letter: string) => letter.repeat(100);
  const first = [line('a'), line('b')].join('\n');
  const second = [line('a'), line('b'), line('c')].join('\n');

  it('replaces the earlier result by a note that says its lines are repeated below, keeps every tool, takes no read back and counts the result', async () => {
    const { run, sent, takenBack } = await runWith([first, second], (messages) => size(messages) < 450);
    expect(sent.at(-1)).toEqual({ tools: ['answer', 'read_view'], results: [SUPERSEDED_TEXT, second] });
    expect(run).toMatchObject({ trimmed: false, refused: false, stubbed: 1 });
    expect(takenBack).toEqual([]);
  });

  it('changes nothing when everything fits, although the newest result repeats the earlier one', async () => {
    const { run, sent } = await runWith([first, second], () => true);
    expect(sent.at(-1)?.results).toEqual([first, second]);
    expect(run.stubbed).toBe(0);
  });

  it.each([
    ['one line differs', [line('a'), line('B'), line('c')].join('\n')],
    ['one line is only a part of a line of the newest', [line('a'), line('b') + 'more', line('c')].join('\n')],
    ['as many lines are held, but not the same ones', [line('c'), line('d'), line('e')].join('\n')],
  ])('keeps an earlier result whole when %s, and leaves out the newest read as before', async (_name, newest) => {
    const { run, sent, takenBack } = await runWith([first, newest], (messages) => size(messages) < 450);
    expect(sent.at(-1)?.results).toEqual([first]);
    expect(run).toMatchObject({ trimmed: true, stubbed: 0 });
    expect(takenBack).toEqual([1]);
  });

  it('offers the final tool only when that is still needed after the note, and takes no read back', async () => {
    const { run, sent } = await runWith([first, second], (messages, tools) => size(messages) < 450 && (size(messages) < 300 || tools.split('\n').length <= 1));
    expect(sent.at(-1)).toEqual({ tools: ['answer'], results: [SUPERSEDED_TEXT, second] });
    expect(run).toMatchObject({ trimmed: false, stubbed: 1 });
  });

  it('never points at lines that were left out: with the newest read dropped, the note stands only against the newest one that stays', async () => {
    const third = [second, line('d'), line('e'), line('f'), line('g')].join('\n');
    const { run, sent, takenBack } = await runWith([first, second, third], (messages) => size(messages) < 450);
    expect(sent.at(-1)?.results).toEqual([SUPERSEDED_TEXT, second]);
    expect(run).toMatchObject({ trimmed: true, stubbed: 1 });
    expect(takenBack).toEqual([2]);
  });
});

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

  it('reports a read the model asked for after the last call was kept for the answer, and none when it asked for none', async () => {
    const wanting = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'read_view', args: {} }, { name: 'answer', args: { text: 'x' } }]);
    expect((await runAgent({ ...base(controlOf()), maxCalls: 2, model: wanting, tools: [reader([]), answerTool([])] })).reserveRefused).toBe(true);
    const content = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'answer', args: { text: 'x' } }]).respond(new AIMessage('Done.'));
    expect((await runAgent({ ...base(controlOf()), maxCalls: 2, model: content, tools: [reader([]), answerTool([])] })).reserveRefused).toBe(false);
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

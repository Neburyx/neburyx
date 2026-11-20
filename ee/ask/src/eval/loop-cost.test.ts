import { afterAll, describe, expect, it } from 'vitest';
import { promptRecordOf, type ModelProvider, type ModelRequest } from '@neburyx/ee-ai-runtime';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { loadSource } from './evaluate.js';
import { loopCostRun } from './loop-cost.js';

afterAll(removeAskFolders);

async function sourceOf() {
  const loaded = await loadSource(makeAskFolder(['src1']), 'src1');
  if (!loaded.ok) throw new Error('the folder does not load');
  return loaded.source;
}

/** A provider that answers by the prompt of the request, and counts them. */
function scripted(replies: Record<string, string>): ModelProvider & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async complete(request: ModelRequest) {
      seen.push(request.promptId);
      const text = replies[request.promptId];
      if (text === undefined) return { status: 'failed', code: 'provider-error', usage: { kind: 'unknown' }, prompt: promptRecordOf(request) };
      return { status: 'ok', text, usage: { kind: 'known', inputTokens: 100, outputTokens: 10 }, model: 'scripted', prompt: promptRecordOf(request) };
    },
  };
}

const ASK = JSON.stringify({ route: 'ask', intent: 'shared', entities: { id: 'W-1' } });
const VIEW = JSON.stringify({ route: 'view' });
const VIEW_KEY = JSON.stringify(['node', 'src1', 'widget', 'W-1']);

describe('the cost of the tool loop on the real assistant turn', () => {
  it('makes one model call more for an ask turn with the loop on than with the steps at 1, the router\'s call counted apart from the loop\'s', async () => {
    const source = await sourceOf();
    const off = scripted({ 'assistant.route': ASK, 'assistant.step': '{"done":true}' });
    const on = scripted({ 'assistant.route': ASK, 'assistant.step': '{"done":true}' });
    const one = await loopCostRun(source, off, 'scripted', { message: 'Show it.', viewElementKeys: [] }, 1);
    const four = await loopCostRun(source, on, 'scripted', { message: 'Show it.', viewElementKeys: [] }, 4);
    expect(one).toMatchObject({ route: 'answered ask', total: 1, calls: { 'assistant.route': 1 }, inputTokens: 100, outputTokens: 10 });
    expect(four).toMatchObject({ route: 'answered ask', total: 2, calls: { 'assistant.route': 1, 'assistant.step': 1 }, inputTokens: 200, outputTokens: 20 });
    expect(four.ms).toBeGreaterThanOrEqual(0);
  });

  it('runs a view turn through the view call with the elements in view read through the stand-in, with the same router call either way', async () => {
    const source = await sourceOf();
    const replies = { 'assistant.route': VIEW, 'assistant.view': JSON.stringify({ sentences: [{ text: 'W-1 is in view.', cites: ['n1'] }] }) };
    const off = await loopCostRun(source, scripted(replies), 'scripted', { message: 'What is shown?', viewElementKeys: [VIEW_KEY] }, 1);
    const on = await loopCostRun(source, scripted(replies), 'scripted', { message: 'What is shown?', viewElementKeys: [VIEW_KEY] }, 4);
    expect(off).toMatchObject({ route: 'answered view', calls: { 'assistant.route': 1, 'assistant.view': 1 } });
    expect(on).toMatchObject({ route: 'answered view', calls: { 'assistant.route': 1, 'assistant.view': 1 } });
  });

  it('reports the route the turn took when it is not an answer: a refusal, and a router that fails', async () => {
    const source = await sourceOf();
    const refused = await loopCostRun(source, scripted({ 'assistant.route': JSON.stringify({ route: 'refuse', cause: 'verdict' }) }), 'scripted', { message: 'Guilty?', viewElementKeys: [] }, 4);
    expect(refused).toMatchObject({ route: 'answered refuse', total: 1 });
    const failed = await loopCostRun(source, scripted({}), 'scripted', { message: 'Show it.', viewElementKeys: [] }, 4);
    expect(failed.route).toBe('unavailable');
  });
});

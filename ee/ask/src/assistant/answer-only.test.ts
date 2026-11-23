import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, answerOf, ok, rig } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore } from './run-store.js';

afterAll(removeAskFolders);

const VIEW = ok('{"route":"view"}');
const TEXT = 'LEAK-CANARY the model writes this itself';

/** Everything a turn leaves: the answer, the audit events and the stored run record without the replies as the provider gave them (the record keeps those by design). A text the model wrote outside `answer` is in none of them. */
const leftBy = async (script: (model: ReturnType<typeof fakeModel>) => ReturnType<typeof fakeModel>): Promise<{ readonly answer: unknown; readonly everything: string; readonly requests: number }> => {
  const store = createMemoryAssistantRunStore();
  const r = await rig({ reply: VIEW, runStore: store, agent: { model: script(fakeModel()) } });
  const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
  const stored = store.runs.map((run) => ({ ...run, callEnds: run.callEnds.map(({ replyText: _reply, ...rest }) => rest), callStarts: run.callStarts.map(({ valuesText: _values, instructionsText: _instructions, ...rest }) => rest) }));
  return { answer, everything: JSON.stringify([answer, r.events, stored]), requests: r.events.filter((event) => event.action === 'assistant.agent').length };
};

describe('the checked answer tool is the only output', () => {
  it('shows no text the model writes beside answer, in the answer, any audit event or the stored record, and the reply that carried it was really consumed', async () => {
    const { answer, everything, requests } = await leftBy((model) =>
      model
        .respondWithTools([{ name: 'view', args: {} }])
        .respond(new AIMessage({ content: TEXT, tool_calls: [{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] }] }, id: 'call-answer' }] })),
    );
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: 'Account A-1 is in view.' }] }] });
    // the read and the reply that held the text and the answer: both were asked for
    expect(requests).toBe(2);
    expect(everything).not.toContain('LEAK-CANARY');
  });

  it('shows no text the model writes instead of answer: the turn ends with the fixed sentence', async () => {
    const { answer, everything } = await leftBy((model) => model.respondWithTools([{ name: 'view', args: {} }]).respond(new AIMessage(TEXT)));
    expect(answer).toMatchObject({ status: 'not-answered' });
    expect(everything).not.toContain('LEAK-CANARY');
  });

  it('cannot carry a text out of the run at all: the run result has no field for it (a field added for it fails here)', async () => {
    let keys: string[] = [];
    const r = await rig({ reply: VIEW, agent: { model: fakeModel().respond(new AIMessage(TEXT)), onRun: (run) => (keys = Object.keys(run).sort()) } });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(keys).toEqual(['assembled', 'called', 'modelCalls', 'offered', 'refused', 'reserveRefused', 'trimmed']);
  });
});

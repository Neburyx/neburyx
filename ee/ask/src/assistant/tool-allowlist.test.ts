import type { AiNotesCapability, CaseSummarizer } from '@neburyx/contracts';
import type { AgentRun } from '@neburyx/ee-assistant-agent';
import { AIMessage, KNOWN_REMOVED_FRAMEWORK_TOOLS, fakeModel, toolListFailures } from '@neburyx/ee-assistant-agent/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, answerOf, ok, offerOf, rig, V } from '../testing/assistant-rig.js';
import { ALLOWED_TOOL_NAMES } from '../testing/tool-allowlist.js';

afterAll(removeAskFolders);

const notes: AiNotesCapability = { append: () => Promise.reject(new Error('no')), canWrite: () => Promise.resolve(undefined), read: () => Promise.resolve({ entries: [], version: 1, save: { state: 'unsaved', savedAt: null } }) };
const summarizer: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: () => Promise.reject(new Error('no')) };
const PATTERN = offerOf('11111111-1111-4111-8111-111111111111', 'Mine');

/** A turn of the real application over a scripted model that records the tools it is bound to, with an Ask folder, a saved pattern, notes, the summary and a typology. */
async function turnOf(script: (model: ReturnType<typeof fakeModel>) => ReturnType<typeof fakeModel>, maxCalls?: number): Promise<{ readonly run: AgentRun; readonly sent: string[][] }> {
  const sent: string[][] = [];
  const model = script(fakeModel());
  const original = model.bindTools.bind(model);
  model.bindTools = ((tools: Parameters<typeof original>[0]) => {
    sent.push(tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort());
    return original(tools);
  }) as typeof model.bindTools;
  let run: AgentRun | undefined;
  const r = await rig({ reply: ok('{"route":"view"}'), patterns: [PATTERN], typology: ['A line of the typology'], agent: { model, ...(maxCalls === undefined ? {} : { maxCalls }), onRun: (ran) => (run = ran) } });
  await answerOf(r.route.handler(r.request(VIEW_BODY, { aiNotes: notes, caseSummarizer: summarizer })));
  if (run === undefined) throw new Error('the turn made no agent run');
  return { run, sent };
}

describe('the tools the Assistant offers a model', () => {
  it('are exactly the allowlist at the sent capture, and the allowlist plus the known removed framework tools at the assembled capture', async () => {
    const { run, sent } = await turnOf((model) => model.respond(new AIMessage('Done.')));
    expect(toolListFailures({ allowed: ALLOWED_TOOL_NAMES, knownRemoved: KNOWN_REMOVED_FRAMEWORK_TOOLS, assembled: run.assembled, sent, requireAllOnFirst: true })).toEqual([]);
    expect([...(sent[0] ?? [])].sort()).toEqual([...ALLOWED_TOOL_NAMES].sort());
    expect([...(run.assembled[0] ?? [])].sort()).toEqual([...ALLOWED_TOOL_NAMES, ...KNOWN_REMOVED_FRAMEWORK_TOOLS].sort());
  });

  it('are `answer` alone on the last allowed call, while the framework still assembles the full list', async () => {
    // the router takes one call; two agent calls are allowed: a read, then the last call
    const { run, sent } = await turnOf((model) => model.respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] } }]).respond(new AIMessage('Done.')), 3);
    expect(run.assembled.at(-1)).toEqual(run.assembled[0]);
    expect(toolListFailures({ allowed: ALLOWED_TOOL_NAMES, knownRemoved: KNOWN_REMOVED_FRAMEWORK_TOOLS, assembled: run.assembled, sent, requireAllOnFirst: true, lastCallOnly: 'answer' })).toEqual([]);
    expect(sent.at(-1)).toEqual(['answer']);
  });

  it('fail the check naming a tool that is missing from what was sent, so a removed registry entry is caught', async () => {
    const { run, sent } = await turnOf((model) => model.respond(new AIMessage('Done.')));
    const without = sent.map((names) => names.filter((name) => name !== 'typology'));
    expect(toolListFailures({ allowed: ALLOWED_TOOL_NAMES, knownRemoved: KNOWN_REMOVED_FRAMEWORK_TOOLS, assembled: run.assembled, sent: without, requireAllOnFirst: true })).toEqual(['request 1: the model was not sent "typology", which is missing from the allowlist\'s tools']);
  });
});

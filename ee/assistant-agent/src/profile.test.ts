import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDeepAgent } from 'deepagents';
import { tool } from 'langchain';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { createCallRecorder, type AuditedCallContext } from '@neburyx/ee-ai-runtime';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { AUDITED_MODEL_NAME, auditChatModel } from './audited-model.js';
import { DEFAULT_TOOL_NAMES, registerProfiles } from './agent-run.js';

const context: AuditedCallContext = { action: 'assistant.agent', actorId: 'person-1', actorRole: 'investigator', traceId: 'trace-1' };
const sink = (events: AuditEvent[]): AuditSink => ({ record: (event) => { events.push(event); return Promise.resolve(); } }) as AuditSink;
const hookOf = (modelRef: string) => ({ recorder: createCallRecorder({ sink: sink([]) }), context: () => context, promptId: 'assistant.agent', promptVersion: 1, modelRef });

/** A model that records what it is bound to and what it is sent, and answers with plain text at once. */
class Recording extends FakeListChatModel {
  readonly bound: string[][] = [];
  readonly sent: BaseMessage[][] = [];
  constructor() {
    super({ responses: ['done'] });
  }
  override bindTools(tools: Parameters<FakeListChatModel['bindTools']>[0]): ReturnType<FakeListChatModel['bindTools']> {
    this.bound.push(tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort());
    return super.bindTools(tools);
  }
  override async _generate(messages: BaseMessage[]): Promise<{ generations: { text: string; message: AIMessage }[] }> {
    this.sent.push(messages);
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  }
}

const readView = tool(() => 'read', { name: 'read_view', description: 'Reads the view.', schema: z.object({}) });
const answer = tool(() => 'checked', { name: 'answer', description: 'Gives the answer.', schema: z.object({ text: z.string() }) });

async function run(model: Recording, wrapped: boolean, modelRef = 'claude-sonnet-5-5'): Promise<void> {
  registerProfiles();
  const used = wrapped ? auditChatModel(model, hookOf(modelRef)) : model;
  const agent = createDeepAgent({ model: used, tools: [readView, answer], systemPrompt: 'rules' });
  await agent.invoke({ messages: [new HumanMessage('question')] });
}

describe('the harness profile of the audited model', () => {
  it('is named by a fixed identifier with one colon and the prefix audited, whatever model is configured, so a model id with a colon cannot stop the profile resolving', () => {
    for (const modelRef of ['claude-sonnet-5-5', 'llama3:8b', 'a:b:c']) {
      const model = auditChatModel(new Recording(), hookOf(modelRef)) as unknown as { model_name: string; getName(): string };
      expect(model.model_name).toBe(AUDITED_MODEL_NAME);
      expect(model.model_name.split(':')).toHaveLength(2);
      expect(model.model_name.startsWith('audited:')).toBe(true);
      expect(['ChatAnthropic', 'ChatOpenAI', 'ChatGoogleGenerativeAI']).not.toContain(model.getName());
    }
  });

  it('has deepagents remove its own tools from the request, so the model is bound only to the product\'s tools', async () => {
    const wrapped = new Recording();
    await run(wrapped, true);
    expect(wrapped.bound.length).toBeGreaterThan(0);
    for (const names of wrapped.bound) {
      for (const name of DEFAULT_TOOL_NAMES) expect(names).not.toContain(name);
      expect(names.every((name) => name === 'answer' || name === 'read_view')).toBe(true);
    }
  });

  it('does not change the system text, the messages or their cache markers that are sent to the model', async () => {
    const withProfile = new Recording();
    await run(withProfile, true);
    const without = new Recording();
    // the same model without the profile: the identifier is taken away, as before this change
    const bare = auditChatModel(without, hookOf('claude-sonnet-5-5')) as unknown as { model_name?: string };
    Object.defineProperty(bare, 'model_name', { value: undefined });
    registerProfiles();
    await createDeepAgent({ model: bare as never, tools: [readView, answer], systemPrompt: 'rules' }).invoke({ messages: [new HumanMessage('question')] });
    expect(JSON.stringify(withProfile.sent[0]?.map((message) => message.content))).toBe(JSON.stringify(without.sent[0]?.map((message) => message.content)));
  });
});

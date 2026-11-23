import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDeepAgent } from 'deepagents';
import { tool } from 'langchain';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { createCallRecorder, type AuditedCallContext } from '@neburyx/ee-ai-runtime';
import type { AuditSink } from '@neburyx/contracts';
import { AUDITED_MODEL_NAME, auditChatModel } from './audited-model.js';
import { DEFAULT_TOOL_NAMES, registerProfiles } from './agent-run.js';

const context: AuditedCallContext = { action: 'assistant.agent', actorId: 'person-1', actorRole: 'investigator', traceId: 'trace-1' };
const sink = { record: () => Promise.resolve() } as unknown as AuditSink;
const hookOf = (modelRef: string) => ({ recorder: createCallRecorder({ sink }), context: () => context, promptId: 'assistant.agent', promptVersion: 1, modelRef });

interface Seen {
  readonly bound: string[][];
  readonly sent: string[];
}

/** A scripted model that notes the tools it is bound to and, for every call, the whole messages it is sent (type, content and extra fields). */
function recordingModel(): { readonly model: ReturnType<typeof fakeModel>; readonly seen: Seen } {
  const seen: Seen = { bound: [], sent: [] };
  const model = fakeModel().respondWithTools([{ name: 'read_view', args: {} }]).respondWithTools([{ name: 'answer', args: { text: 'x' } }]).respond(new AIMessage('Done.'));
  const original = model.bindTools.bind(model);
  model.bindTools = ((tools: Parameters<typeof original>[0]) => {
    seen.bound.push(tools.map((entry) => ('name' in entry ? String(entry.name) : '')).sort());
    const bound = original(tools);
    const invoke = bound.invoke.bind(bound);
    bound.invoke = ((messages: BaseMessage[], options?: never) => {
      seen.sent.push(JSON.stringify(messages.map((message) => ({ type: message.type, content: message.content, extra: message.additional_kwargs }))));
      return invoke(messages, options);
    }) as typeof bound.invoke;
    return bound;
  }) as typeof model.bindTools;
  return { model, seen };
}

const readView = tool(() => 'read', { name: 'read_view', description: 'Reads the view.', schema: z.object({}) });
const answer = tool(() => 'checked', { name: 'answer', description: 'Gives the answer.', schema: z.object({ text: z.string() }) });

/** A two-call loop through deepagents on the audited model, with the profile or, when `profileless`, with the identifier taken away. */
async function loop(profileless: boolean, modelRef = 'claude-sonnet-5-5'): Promise<Seen> {
  registerProfiles();
  const { model, seen } = recordingModel();
  const wrapped = auditChatModel(model, hookOf(modelRef));
  if (profileless) Object.defineProperty(wrapped, 'model_name', { value: undefined });
  await createDeepAgent({ model: wrapped, tools: [readView, answer], systemPrompt: 'rules' }).invoke({ messages: [new HumanMessage('question')] });
  return seen;
}

describe('the harness profile of the audited model', () => {
  it('is named by a fixed identifier with one colon and the prefix audited, whatever model is configured, so a model id with a colon cannot stop the profile resolving', () => {
    for (const modelRef of ['claude-sonnet-5-5', 'llama3:8b', 'a:b:c']) {
      const model = auditChatModel(fakeModel(), hookOf(modelRef)) as unknown as { model_name: string; getName(): string };
      expect(model.model_name).toBe(AUDITED_MODEL_NAME);
      expect(model.model_name.split(':')).toHaveLength(2);
      expect(model.model_name.startsWith('audited:')).toBe(true);
      expect(['ChatAnthropic', 'ChatOpenAI', 'ChatGoogleGenerativeAI']).not.toContain(model.getName());
    }
  });

  it('has deepagents remove its own tools from every request, so the model is bound only to the product\'s tools; a model with no identifier is sent them', async () => {
    const without = await loop(true);
    expect(without.bound.flat()).toContain('read_file');
    const withProfile = await loop(false);
    expect(withProfile.bound.length).toBeGreaterThan(1);
    for (const names of withProfile.bound) {
      for (const name of DEFAULT_TOOL_NAMES) expect(names).not.toContain(name);
      expect(names.every((name) => name === 'answer' || name === 'read_view')).toBe(true);
    }
  });

  it('changes nothing but the tools: every call sends the same whole messages (type, content, extra fields) with the profile and without it', async () => {
    const without = await loop(true);
    const withProfile = await loop(false);
    expect(withProfile.sent.length).toBeGreaterThan(1);
    expect(withProfile.sent).toEqual(without.sent);
    // the profile was the only change: the tools the model is bound to differ
    expect(withProfile.bound).not.toEqual(without.bound);
  });
});

import { createDeepAgent, registerHarnessProfile } from 'deepagents';
import { AIMessage, ToolMessage, createMiddleware, tool } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ZodObject, ZodRawShape } from 'zod';
import { withoutEarlierThinking, withoutThinking } from './audited-model.js';

/** The names deepagents adds on its own: the file tools, the shell, the sub-agent tool, the async-task tools and the planning tool. None is ever offered or run. */
export const DEFAULT_TOOL_NAMES = ['ls', 'read_file', 'write_file', 'edit_file', 'delete', 'glob', 'grep', 'execute', 'task', 'write_todos', 'start_async_task', 'check_async_task', 'update_async_task', 'cancel_async_task', 'list_async_tasks'] as const;

/** The profile key of the audited chat model (its `model_name` is `audited:model`), and of a bare model of each provider. */
const AUDITED_PROFILE_KEY = 'audited';
const PROFILE_KEYS = [AUDITED_PROFILE_KEY, 'openai', 'anthropic'] as const;
let profilesRegistered = false;

/**
 * Registers the profile that has deepagents' exclusion middleware remove its own tools from every request. It applies to the audited model through its `model_name`, and to a bare model of a provider; a model that names
 * neither gets no profile and `TurnLimits` alone keeps deepagents' tools from it.
 */
export function registerProfiles(): void {
  if (profilesRegistered) return;
  profilesRegistered = true;
  for (const key of PROFILE_KEYS) registerHarnessProfile(key, { excludedTools: [...DEFAULT_TOOL_NAMES], generalPurposeSubagent: { enabled: false } });
}

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodObject<ZodRawShape>;
  /** What the model reads back. The product's gate runs behind it; an error it throws ends the run and is thrown to the caller. */
  readonly run: (args: Readonly<Record<string, unknown>>) => Promise<string>;
}

/** What a tool or the turn's limits may do to the run, and what the run tells back. */
export interface AgentControl {
  /** Ends the run before the next model call. */
  stop: boolean;
  /** The model calls made so far, kept up to date for the tools and the caller. */
  calls: number;
  /** Model calls a tool made on the turn's behalf (the summary's): they count against the call limit. */
  extra: number;
  /** Set by a tool: from the next model call on only the final tool is offered and run. */
  answerOnly: boolean;
}

export interface AgentRunOptions {
  readonly model: BaseChatModel;
  readonly system: string;
  readonly user: string;
  readonly tools: readonly AgentTool[];
  readonly control: AgentControl;
  /** The model calls the run may make; on the last one only `finalTool` is offered. */
  readonly maxCalls: number;
  readonly finalTool: string;
  readonly signal: AbortSignal;
  /** Called with the text of each model request as it will be sent (the system prompt deepagents assembled, the messages and the tools offered), before it counts as a call; false ends the run without the call. */
  readonly beforeCall?: (request: { readonly system: string; readonly messages: readonly string[]; readonly tools: string }) => boolean;
  /** Called with the number of reads that stay in a request that was sent without its newest reads, before that request is sent: the caller takes every later read back from what it keeps. */
  readonly onTrim?: (kept: number) => void;
}

export interface AgentRun {
  /** The tool names offered in each model request, in order. */
  readonly offered: readonly (readonly string[])[];
  readonly called: readonly { readonly name: string; readonly args: unknown }[];
  readonly modelCalls: number;
  /** Whether `beforeCall` ended the run by refusing a request. */
  readonly refused: boolean;
  /** Whether a request that did not fit was sent without its newest reads (the oldest are kept, the call offers the final tool only). */
  readonly trimmed: boolean;
  /** That the model asked for a read of the run's own tools after the last call was kept for the final tool: the call limit cut its reading short. */
  readonly reserveRefused: boolean;
}

const END_TEXT = 'Done.';
/** The graph steps one model call can take with deepagents' own middleware, and a few spare; the call limit, not the framework's recursion limit, ends a turn. */
const RECURSION_PER_CALL = 6;
const RECURSION_SPARE = 10;

/** A tool as the provider is sent it: its name, description and the schema of its input. */
function toolText(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return '';
  const description = 'description' in entry && typeof entry.description === 'string' ? entry.description : '';
  try {
    return `${nameOf(entry)} ${description} ${JSON.stringify('schema' in entry ? entry.schema : {})}`;
  } catch {
    // a schema that cannot be written out is counted by its name and description only
    return `${nameOf(entry)} ${description}`;
  }
}

/** The messages without their newest group of reads (the last reply that called tools, and what follows it); undefined when one group is left or when the newest holds the final tool, an answer, which is never dropped. */
function withoutNewestRead(messages: readonly BaseMessage[], finalTool: string): BaseMessage[] | undefined {
  const calls = (message: BaseMessage): { name: string }[] => (message.type === 'ai' && 'tool_calls' in message && Array.isArray(message.tool_calls) ? message.tool_calls : []);
  const groups = messages.flatMap((message, index) => (calls(message).length > 0 ? [index] : []));
  const last = groups.at(-1);
  if (groups.length < 2 || last === undefined) return undefined;
  return calls(messages[last] as BaseMessage).some((call) => call.name === finalTool) ? undefined : messages.slice(0, last);
}

const nameOf = (entry: unknown): string => (typeof entry === 'object' && entry !== null && 'name' in entry && typeof entry.name === 'string' ? entry.name : '');

/**
 * One deepagents run over exactly the tools given. The model is offered only those tools (deepagents' own are filtered out of every request), and a call to any other name is refused before anything runs, so the
 * answer-only last call cannot read. Calls of one model response run one after another. The run ends when the model calls no tool, when a tool or a limit sets `control.stop`, or at the call limit; an error a tool throws
 * is thrown from here, never handed to the model; the text the model writes is not returned.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRun> {
  registerProfiles();
  const allowed = new Set(options.tools.map((entry) => entry.name));
  const called: { name: string; args: unknown }[] = [];
  const offered: string[][] = [];
  let reserveRefused = false;
  let failure: { readonly error: unknown } | undefined;
  let queue: Promise<void> = Promise.resolve();
  const structured: StructuredToolInterface[] = options.tools.map(
    (entry) =>
      tool(
        (args: Record<string, unknown>) => {
          // the calls of one model response are run one after another, so that a stop set by one is seen by the next
          const result = queue.then(async () => {
            if (options.control.stop) return 'Not run: the turn has ended.';
            called.push({ name: entry.name, args });
            if (entry.name !== options.finalTool) readsRun += 1;
            try {
              return await entry.run(args);
            } catch (error) {
              failure ??= { error };
              options.control.stop = true;
              return 'Not run: the turn has ended.';
            }
          });
          // a failure is kept in `failure` and thrown after the run; the chain only has to go on
          queue = result.then(() => undefined);
          return result;
        },
        { name: entry.name, description: entry.description, schema: entry.schema },
      // the tool helper's type does not carry the schema's own, which the structured tool interface accepts
      ) as unknown as StructuredToolInterface,
  );
  let modelCalls = 0;
  let refused = false;
  let trimmed = false;
  let previousTools: string | undefined;
  // the number of reads run (the final tool is not one) when each model call started
  let readsRun = 0;
  const startRan: number[] = [];
  const reserved = (): boolean => options.control.answerOnly || modelCalls + options.control.extra >= options.maxCalls;
  const limits = createMiddleware({
    name: 'TurnLimits',
    wrapModelCall: async (request, handler) => {
      if (options.control.stop || modelCalls + options.control.extra >= options.maxCalls) return new AIMessage(END_TEXT);
      const lastCall = options.control.answerOnly || modelCalls + 1 + options.control.extra >= options.maxCalls;
      const tools = request.tools.filter((entry) => (lastCall ? nameOf(entry) === options.finalTool : allowed.has(nameOf(entry))));
      const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));
      const system = textOf(request.systemMessage.content);
      // what is sent: a call whose list of tools differs from the one before carries no thinking block, any other carries the last reply's
      const sentOf = (messages: readonly BaseMessage[], toolList: readonly unknown[]): BaseMessage[] => (previousTools !== undefined && previousTools !== toolList.map(nameOf).sort().join(',') ? withoutThinking(messages) : withoutEarlierThinking(messages));
      const fitsWith = (messages: readonly BaseMessage[], toolList: readonly unknown[]): boolean => options.beforeCall?.({ system, messages: sentOf(messages, toolList).map((message) => textOf(message.content)), tools: toolList.map(toolText).join('\n') }) ?? true;
      let sentMessages = request.messages;
      let sentTools = tools;
      if (!fitsWith(request.messages, tools)) {
        // with the final tool only, then without the newest reads one at a time, until it fits; with no read left to drop, or the newest group an answer, the run ends
        const finalOnly = request.tools.filter((entry) => nameOf(entry) === options.finalTool);
        let shorter: BaseMessage[] | undefined = [...request.messages];
        let groupsLeftOut = 0;
        let keep = readsRun;
        if (!fitsWith(shorter, finalOnly)) {
          for (;;) {
            const cut = withoutNewestRead(shorter ?? [], options.finalTool);
            shorter = cut;
            if (cut === undefined) break;
            // the reads that stay are those that ran before the model call that made the oldest reply left out
            keep = startRan[startRan.length - 1 - groupsLeftOut] ?? keep;
            groupsLeftOut += 1;
            if (fitsWith(cut, finalOnly)) break;
          }
        }
        if (shorter === undefined) {
          refused = true;
          options.control.stop = true;
          return new AIMessage(END_TEXT);
        }
        if (keep < readsRun) {
          trimmed = true;
          options.onTrim?.(keep);
        }
        options.control.answerOnly = true;
        sentMessages = shorter;
        sentTools = finalOnly;
      }
      modelCalls += 1;
      startRan.push(readsRun);
      options.control.calls = modelCalls;
      const offeredNow = sentTools.map(nameOf).sort().join(',');
      offered.push(offeredNow === '' ? [] : offeredNow.split(','));
      // a thinking block is bound to the list of tools it was made with, so a call whose list differs from the one before carries none
      const changed = previousTools !== undefined && previousTools !== offeredNow;
      previousTools = offeredNow;
      return handler({ ...request, tools: sentTools, messages: changed || sentMessages !== request.messages ? withoutThinking(sentMessages) : sentMessages });
    },
    wrapToolCall: async (request, handler) => {
      const { name, id } = request.toolCall;
      // a read the model asked for after the calls were kept for the answer: the call limit cut the reading short
      if (allowed.has(name) && reserved() && name !== options.finalTool) reserveRefused = true;
      if (!allowed.has(name) || (reserved() && name !== options.finalTool)) return new ToolMessage({ content: 'This tool is not available now.', tool_call_id: id ?? name, name });
      try {
        return await handler(request);
      } catch {
        // a call whose arguments do not fit the tool is told so in a fixed sentence: the error of the framework holds a trace and local paths
        return new ToolMessage({ content: 'The arguments did not fit this tool. Call it again with exactly its values.', tool_call_id: id ?? name, name });
      }
    },
  });
  const agent = createDeepAgent({ model: options.model, tools: structured, systemPrompt: options.system, middleware: [limits] });
  try {
    await agent.invoke({ messages: [{ role: 'user', content: options.user }] }, { signal: options.signal, recursionLimit: options.maxCalls * RECURSION_PER_CALL + RECURSION_SPARE });
  } catch (error) {
    throw failure?.error ?? error;
  }
  if (failure !== undefined) throw failure.error;
  return { offered, called, modelCalls, refused, trimmed, reserveRefused };
}

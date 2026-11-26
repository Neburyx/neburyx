import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A reply the stand-in does not answer until a case says so (or never): the call stays pending at the model. */
export const HOLD = { hold: true } as const;
type Reply = string | typeof HOLD;

/** A stand-in for the model service on the loopback address: it records the body of each request and answers the next reply a case gave it (no intent when none is left). */
export interface ModelStub {
  readonly baseUrl: string;
  /** The body of each request it received, in order. */
  readonly requests: string[];
  /** The replies it will give, the next first; `HOLD` leaves that call pending. */
  readonly replies: Reply[];
  /** The calls that are pending now: held, not answered, and not given up by the caller (a call the application aborts leaves this count). */
  held(): number;
  /** Answers every held call with the reply given, and holds no later call. */
  release(reply: string): void;
  reset(): void;
  close(): Promise<void>;
}

const NO_INTENT_REPLY = '{"intent":null,"entities":{}}';

type Json = Record<string, unknown>;

const jsonOf = (text: string | undefined): Json | undefined => {
  try {
    const data: unknown = JSON.parse(text ?? '');
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Json) : undefined;
  } catch {
    return undefined;
  }
};

/** The reply a case gives for `answer` in the shapes it is written in ({sentences} or {columns, rows}), as the tool's input: the blocks of one kind. */
function blocksOf(reply: Json): Json {
  if ('blocks' in reply) return reply;
  const { noDescription, ...rest } = reply;
  const extra = noDescription === undefined ? {} : { noDescription };
  if ('sentences' in rest) return { blocks: [{ kind: 'sentences', sentences: rest['sentences'] }], ...extra };
  if ('columns' in rest) return { blocks: [{ kind: 'table', columns: rest['columns'], rows: rest['rows'] }], ...extra };
  return reply;
}

/**
 * What the assistant's agent is told over the wire. A case writes the replies of a turn as text, in order: the router's, then the next read of each step (`{"tool":…}`) or `{"done":true}`, then the answer's sentences.
 * A request that carries tools is a call of the agent, and the next reply is read as that script: the router's own `ask` reply, when it names values itself, is the first read, a request for a tool is a tool call, and `{"done":true}` is the call of
 * `answer` the following reply gives. A request that offers `answer` alone (the last call of a turn, or one held to answer) is the call of `answer` the next reply gives. After the answer, a reply that is not JSON is the text
 * the model writes after it. Any other text ends the turn.
 */
function agentScript(routerReply: () => string | undefined, answerOnly: () => boolean) {
  let started = false;
  let answered = false;
  const toolUse = (name: string, input: Json): Json[] => [{ type: 'tool_use', id: `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input }];
  return (next: () => string, upcoming: () => string | undefined): Json[] => {
    if (answered) {
      const closing = upcoming();
      return [{ type: 'text', text: closing !== undefined && jsonOf(closing) === undefined ? next() : 'Done.' }];
    }
    if (answerOnly()) {
      answered = true;
      let reply = jsonOf(next());
      if (reply?.['done'] === true) reply = jsonOf(next());
      return reply === undefined ? [{ type: 'text', text: 'Done.' }] : toolUse('answer', blocksOf(reply));
    }
    if (!started) {
      started = true;
      // the route of a reply that holds text before it is its last line
      const routed = jsonOf(routerReply()?.trimEnd().split('\n').at(-1));
      const named = (routed?.['entities'] ?? {}) as Json;
      if (routed?.['route'] === 'ask' && typeof routed['intent'] === 'string' && Object.keys(named).length > 0) {
        const entities = named;
        const { pattern, ...rest } = entities;
        const saved = routed['intent'] === 'saved-pattern' && typeof pattern === 'string';
        return toolUse(saved ? pattern : routed['intent'], saved ? rest : entities);
      }
    }
    const text = next();
    const step = jsonOf(text);
    if (step?.['done'] === true) {
      answered = true;
      const reply = jsonOf(next());
      return reply === undefined ? [{ type: 'text', text: 'Done.' }] : toolUse('answer', blocksOf(reply));
    }
    if (step !== undefined && typeof step['tool'] === 'string') return toolUse(step['tool'], (step['values'] ?? {}) as Json);
    return [{ type: 'text', text }];
  };
}

/** `fallback` answers a request from its body when no reply is queued: a model that keeps asking for another read, whatever it is asked. */
export async function startModelStub(fallback?: (body: string) => string): Promise<ModelStub> {
  const requests: string[] = [];
  const replies: Reply[] = [];
  const pending: Array<(reply: string) => void> = [];
  let open = true;
  let agent: ReturnType<typeof agentScript> | undefined;
  let routed: string | undefined;
  let sent = 0;
  let offeredNow: (string | undefined)[] = [];
  const answerWith = (response: ServerResponse, body: string, first?: string): void => {
    if (response.destroyed) return;
    let firstUsed = first === undefined;
    const next = (): string => {
      if (!firstUsed && first !== undefined) {
        firstUsed = true;
        return first;
      }
      const reply = replies.shift();
      return typeof reply === 'string' ? reply : (fallback?.(body) ?? NO_INTENT_REPLY);
    };
    offeredNow = ((jsonOf(body)?.['tools'] ?? []) as { name?: string }[]).map((entry) => entry.name);
    const calling = jsonOf(body)?.['tools'] !== undefined;
    let content: Json[];
    if (calling) {
      agent ??= agentScript(() => routed, () => offeredNow.length === 1 && offeredNow[0] === 'answer');
      content = agent(next, () => (typeof replies[0] === 'string' ? replies[0] : undefined));
    } else {
      agent = undefined;
      routed = next();
      content = [{ type: 'text', text: routed }];
    }
    const toolCall = content.some((block) => block['type'] === 'tool_use');
    response.writeHead(200, { 'content-type': 'application/json' });
    // a message has an id of its own: the agent's state merges messages with the same id, which would drop a call
    response.end(JSON.stringify({ id: `msg_${(sent += 1)}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: toolCall ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }));
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(body);
      if (replies[0] === HOLD && open) {
        replies.shift();
        const entry = (text: string): void => answerWith(response, body, text);
        pending.push(entry);
        response.on('close', () => {
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
        });
        return;
      }
      answerWith(response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    replies,
    held: () => pending.length,
    release: (reply) => {
      open = false;
      for (const answerHeld of pending.splice(0)) answerHeld(reply);
    },
    reset: () => {
      requests.length = 0;
      replies.length = 0;
      pending.length = 0;
      open = true;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

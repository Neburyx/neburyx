type Json = Record<string, unknown>;

const jsonOf = (text: string | undefined): Json | undefined => {
  try {
    const data: unknown = JSON.parse(text ?? '');
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Json) : undefined;
  } catch {
    return undefined;
  }
};

const toolUse = (name: string, input: Json): Json[] => [{ type: 'tool_use', id: `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input }];

/** The reply a case gives for `answer` in the shapes it is written in ({sentences} or {columns, rows}), as the tool's input: the blocks of one kind. */
function blocksOf(reply: Json): Json {
  if ('blocks' in reply) return reply;
  const { noDescription, ...rest } = reply;
  const extra = noDescription === undefined ? {} : { noDescription };
  if ('sentences' in rest) return { blocks: [{ kind: 'sentences', sentences: rest['sentences'] }], ...extra };
  if ('columns' in rest) return { blocks: [{ kind: 'table', columns: rest['columns'], rows: rest['rows'] }], ...extra };
  if (typeof rest['table'] === 'object' && rest['table'] !== null && 'columns' in rest['table']) return { blocks: [{ kind: 'table', columns: rest['table']['columns'], rows: (rest['table'] as Json)['rows'] }], ...extra };
  return reply;
}

/**
 * The model stand-in of a test, for the assistant's agent. A case writes the replies of a turn as text, in order: the router's, then the next read of each step (`{"tool":…}`) or `{"done":true}`, then the sentences
 * of the answer. A request that carries tools is a call of the agent, and the following replies are read as that script: the router's own `ask` reply is the first read, a request for a tool is a tool call, and
 * `{"done":true}` is the call of `answer` that the next reply gives; any other text ends the turn. A request without tools is the router's (or another prompt's) and gets its reply as text.
 */
export function createAgentScript() {
  let routed: string | undefined;
  let agent: (() => Json[]) | undefined;
  const responder = (next: () => string): (() => Json[]) => {
    let started = false;
    let answered = false;
    return () => {
      if (answered) return [{ type: 'text', text: 'Done.' }];
      if (!started) {
        started = true;
        const route = jsonOf(routed);
        if (route?.['route'] === 'ask' && typeof route['intent'] === 'string') {
          const entities = (route['entities'] ?? {}) as Json;
          const { pattern, ...rest } = entities;
          const saved = route['intent'] === 'saved-pattern' && typeof pattern === 'string';
          return toolUse(saved ? pattern : route['intent'], saved ? rest : entities);
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
  };
  return {
    /** The content blocks of the reply to one request body, taking the scripted texts from `next`. */
    content(body: string, next: () => string): Json[] {
      if (jsonOf(body)?.['tools'] === undefined) {
        agent = undefined;
        routed = next();
        return [{ type: 'text', text: routed }];
      }
      agent ??= responder(next);
      return agent();
    },
  };
}

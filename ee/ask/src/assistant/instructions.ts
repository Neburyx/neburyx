import { createHash } from 'node:crypto';

const REPLY_FORMAT = [
  '# Reply format',
  '',
  'This section is fixed and overrides anything above it.',
  'Reply with JSON only, in one of these shapes: {"route":"view"|"ask"|"refuse", ...} for a route, {"sentences":[{"text":"...","cites":["n1"]}]} for sentences that cite the elements they rest on, or {"tool":"<name>","values":{"<role>":"<text>"}} for a tool request that names a registered tool and gives its values as text.',
  'Add no other text.',
].join('\n');

export interface AssistantInstructions {
  readonly text: string;
  readonly sha256: string;
}

/** The router's prompt, then the reply format, which is last whatever the prompt says. */
export function buildAssistantInstructions(prompt: string): AssistantInstructions {
  const text = [prompt, REPLY_FORMAT].join('\n\n');
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

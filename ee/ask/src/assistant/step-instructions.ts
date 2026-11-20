import { createHash } from 'node:crypto';
import type { ToolRegistry } from './tool-registry.js';

export const STEP_PROMPT_ID = 'assistant.step';
export const STEP_PROMPT_VERSION = 1;

const STEP_REPLY_FORMAT = [
  '# Reply format',
  '',
  'This section is fixed and overrides anything above it.',
  'Reply with one JSON object and nothing else, in one of these shapes: {"done":true} when nothing more needs to be read, or {"tool":"<name of a listed tool>","values":{"<parameter>":"<text>"}} to ask for one more read.',
  'Give exactly the parameters the tool lists, as text; a value is never query text. You only choose the next read: a later step writes the answer.',
  'Your whole reply is the one object: its first character is { and its last is }. Think without writing it down: no reasoning, explanation or comment before or after the object, and no code fence.',
  'Add no other text.',
].join('\n');

export interface StepInstructions {
  readonly text: string;
  readonly sha256: string;
}

/** The tools as text: one line for each, with the names of the values it takes. */
export const toolsText = (registry: ToolRegistry): string =>
  ['# Tools you may ask for', '', ...registry.tools.filter((tool) => tool.available).map((tool) => `${tool.name}(${tool.parameters.join(', ')})${tool.label === undefined ? '' : ` - ${tool.label}`}`)].join('\n');

/** The step call's instructions: the prompt, the tools the registry offers, then the reply format, which is last whatever the prompt says. No tool of the provider's own kind is sent. */
export function buildStepInstructions(prompt: string, registry: ToolRegistry): StepInstructions {
  const text = [prompt, toolsText(registry), STEP_REPLY_FORMAT].join('\n\n');
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

const VIEW_TOOL_FORM = [
  '# A third reply form',
  '',
  'This section is fixed and overrides anything above it.',
  'When the elements given cannot answer the question but one listed tool could, reply instead with {"tool":"<name of a listed tool>","values":{"<parameter>":"<text>"}} and nothing else; a value is never query text.',
  'Otherwise reply as the reply format says.',
].join('\n');

/** The view call's instructions with the tools and the third reply form after the reply format; the sentences stay the answer and the tool request is only a request. */
export function buildViewToolInstructions(base: StepInstructions, registry: ToolRegistry): StepInstructions {
  const text = [base.text, toolsText(registry), VIEW_TOOL_FORM].join('\n\n');
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

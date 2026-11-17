import { ASK_FOLDER_LIMITS } from '@neburyx/contracts';
import { fileURLToPath } from 'node:url';
import { readText } from '../folder/load.js';
import { buildAssistantInstructions, type AssistantInstructions } from './instructions.js';

const SHIPPED_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

const PROMPT_SETTING = 'NEBURYX_ASSISTANT_PROMPT_FILE';
const SHIPPED_PROMPT = 'assistant-router.md';

export type AssistantInstructionsLoad = { readonly ok: true; readonly instructions: AssistantInstructions } | { readonly ok: false; readonly problems: readonly string[] };

interface LoadOptions {
  /** Only a test sets this, to a folder that stands in for the one shipped with the product. */
  readonly shippedDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Reads the router's prompt from the file the operator names or else the one shipped with the product. A problem names the setting or the shipped file with the setting that replaces it, never a path or any text. */
export async function loadAssistantInstructions(options: LoadOptions = {}): Promise<AssistantInstructionsLoad> {
  const replacement = options.env?.[PROMPT_SETTING];
  const shippedPath = `${options.shippedDirectory ?? SHIPPED_DIRECTORY}${SHIPPED_PROMPT}`;
  const shippedLabel = `the shipped ${SHIPPED_PROMPT} (replace it with ${PROMPT_SETTING})`;
  if (replacement === undefined || replacement === '') {
    const shipped = await readText(shippedPath, shippedLabel, ASK_FOLDER_LIMITS.classificationBytes);
    return typeof shipped === 'string' ? { ok: false, problems: [shipped] } : { ok: true, instructions: buildAssistantInstructions(shipped.text) };
  }
  if (!replacement.startsWith('/')) return { ok: false, problems: [`${PROMPT_SETTING} must be an absolute path`] };
  const read = await readText(replacement, PROMPT_SETTING, ASK_FOLDER_LIMITS.classificationBytes);
  if (typeof read === 'string') return { ok: false, problems: [read] };
  if (read.text.trim() === '') return { ok: false, problems: [`${PROMPT_SETTING}: the file is empty; the prompt carries the rules the router must follow`] };
  return { ok: true, instructions: buildAssistantInstructions(read.text) };
}

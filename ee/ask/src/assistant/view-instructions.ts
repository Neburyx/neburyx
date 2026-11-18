import { fileURLToPath } from 'node:url';
import { buildSummaryInstructions, type SummaryInstructions } from '../case-summary/instructions.js';
import { textOf } from '../case-summary/load-instructions.js';

const SHIPPED_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

const PROMPT_SETTING = 'NEBURYX_ASSISTANT_VIEW_PROMPT_FILE';
const TYPOLOGY_SETTING = 'NEBURYX_ASSISTANT_TYPOLOGY_FILE';
const SHIPPED_PROMPT = 'assistant-view.md';
const SHIPPED_TYPOLOGY = 'aml-typologies.md';

/** The instructions of the view answer: the prompt, the typologies and the reply format, which is last whatever the other two say. It is the summary's format, so one check reads both. */
export type ViewInstructions = SummaryInstructions;

export type ViewInstructionsLoad = { readonly ok: true; readonly instructions: ViewInstructions } | { readonly ok: false; readonly problems: readonly string[] };

interface LoadOptions {
  /** Only a test sets this, to a folder that stands in for the one shipped with the product. */
  readonly shippedDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Reads the prompt and the typology text, each from the file the operator names or else the one shipped with the product. A problem names the setting or the shipped file with the setting that replaces it, never a path or any text. */
export async function loadViewInstructions(options: LoadOptions = {}): Promise<ViewInstructionsLoad> {
  const directory = options.shippedDirectory ?? SHIPPED_DIRECTORY;
  const prompt = await textOf(options.env, PROMPT_SETTING, `${directory}${SHIPPED_PROMPT}`, `the shipped ${SHIPPED_PROMPT} (replace it with ${PROMPT_SETTING})`, true);
  const typology = await textOf(options.env, TYPOLOGY_SETTING, `${directory}${SHIPPED_TYPOLOGY}`, `the shipped ${SHIPPED_TYPOLOGY} (replace it with ${TYPOLOGY_SETTING})`, false);
  const problems = [prompt, typology].filter((found): found is string => typeof found === 'string');
  if (typeof prompt === 'string' || typeof typology === 'string') return { ok: false, problems };
  return { ok: true, instructions: buildSummaryInstructions(prompt.text, typology.text) };
}

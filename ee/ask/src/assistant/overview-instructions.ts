import { fileURLToPath } from 'node:url';
import { buildSummaryInstructions, type SummaryInstructions } from '../case-summary/instructions.js';
import { textOf } from '../case-summary/load-instructions.js';

const SHIPPED_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

const PROMPT_SETTING = 'NEBURYX_ASSISTANT_OVERVIEW_PROMPT_FILE';
const SHIPPED_PROMPT = 'assistant-overview.md';

/** The instructions of the overview beside a verdict refusal: the prompt and the reply format, which is last whatever the prompt says. It is the summary's format, so one check reads every answer from the view. */
export type OverviewInstructions = SummaryInstructions;

export type OverviewInstructionsLoad = { readonly ok: true; readonly instructions: OverviewInstructions } | { readonly ok: false; readonly problems: readonly string[] };

interface LoadOptions {
  /** Only a test sets this, to a folder that stands in for the one shipped with the product. */
  readonly shippedDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Reads the prompt from the file the operator names or else the one shipped with the product. A problem names the setting or the shipped file with the setting that replaces it, never a path or any text. */
export async function loadOverviewInstructions(options: LoadOptions = {}): Promise<OverviewInstructionsLoad> {
  const directory = options.shippedDirectory ?? SHIPPED_DIRECTORY;
  const prompt = await textOf(options.env, PROMPT_SETTING, { path: `${directory}${SHIPPED_PROMPT}`, label: `the shipped ${SHIPPED_PROMPT} (replace it with ${PROMPT_SETTING})` }, true);
  if (typeof prompt === 'string') return { ok: false, problems: [prompt] };
  return { ok: true, instructions: buildSummaryInstructions(prompt.text, '') };
}

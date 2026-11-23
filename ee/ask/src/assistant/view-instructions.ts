import { fileURLToPath } from 'node:url';
import { type SummaryInstructions } from '../case-summary/instructions.js';
import { instructionsBuilder, textOf, typologyOverrideOf } from '../case-summary/load-instructions.js';

const SHIPPED_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

const PROMPT_SETTING = 'NEBURYX_ASSISTANT_VIEW_PROMPT_FILE';
const TYPOLOGY_SETTING = 'NEBURYX_ASSISTANT_TYPOLOGY_FILE';
const SHIPPED_PROMPT = 'assistant-view.md';

/** The instructions of the view answer: the prompt, the typologies and the reply format, which is last whatever the other two say. It is the summary's format, so one check reads both. */
export type ViewInstructions = SummaryInstructions;

/** The items of the typology file's list (the lines that begin with `- `), kept apart so that the typology can also be read as a tool; the heading and the paragraph around them are not lines. */
export const typologyLinesOf = (text: string): readonly string[] => text.split('\n').flatMap((line) => (line.startsWith('- ') && line.slice(2).trim() !== '' ? [line.slice(2).trim()] : []));

export type ViewInstructionsLoad =
  | {
      readonly ok: true;
      /** The instructions with the typology of the operator's file when one is named, and none otherwise. */
      readonly instructions: ViewInstructions;
      readonly typology: readonly string[];
      /** The instructions for a source whose Ask folder holds the given typology text; the operator's file, when one is named, takes its place. */
      readonly instructionsFor: (sourceTypology: string) => ViewInstructions;
      /** The items of the typology of that source, the operator's file's when one is named. */
      readonly typologyFor: (sourceTypology: string) => readonly string[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

interface LoadOptions {
  /** Only a test sets this, to a folder that stands in for the one shipped with the product. */
  readonly shippedDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Reads the prompt from the file the operator names or else the one shipped with the product, and the typology text from the file the operator names (none shipped: with no file there is no typology section). A problem names the setting or the shipped file with the setting that replaces it, never a path or any text. */
export async function loadViewInstructions(options: LoadOptions = {}): Promise<ViewInstructionsLoad> {
  const directory = options.shippedDirectory ?? SHIPPED_DIRECTORY;
  const prompt = await textOf(options.env, PROMPT_SETTING, { path: `${directory}${SHIPPED_PROMPT}`, label: `the shipped ${SHIPPED_PROMPT} (replace it with ${PROMPT_SETTING})` }, true);
  const typology = await typologyOverrideOf(options.env, TYPOLOGY_SETTING);
  const problems = [prompt, typology].filter((found): found is string => typeof found === 'string');
  if (typeof prompt === 'string' || typeof typology === 'string') return { ok: false, problems };
  const instructionsFor = instructionsBuilder(prompt.text, typology?.text);
  const typologyFor = (sourceTypology: string): readonly string[] => typologyLinesOf(typology?.text ?? sourceTypology);
  return { ok: true, instructions: instructionsFor(''), typology: typologyFor(''), instructionsFor, typologyFor };
}

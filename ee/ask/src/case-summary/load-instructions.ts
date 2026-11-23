import { ASK_FOLDER_LIMITS } from '@neburyx/contracts';
import { fileURLToPath } from 'node:url';
import { readText } from '../folder/load.js';
import { buildSummaryInstructions, type SummaryInstructions } from './instructions.js';

const SHIPPED_DIRECTORY = fileURLToPath(new URL('../../prompts/', import.meta.url));

const PROMPT_SETTING = 'NEBURYX_SUMMARY_PROMPT_FILE';
const TYPOLOGY_SETTING = 'NEBURYX_SUMMARY_TYPOLOGY_FILE';

const SHIPPED_PROMPT = 'summary-prompt.md';

export type InstructionsLoad =
  | {
      readonly ok: true;
      /** The instructions with the typology of the operator's file when one is named, and none otherwise. */
      readonly instructions: SummaryInstructions;
      /** The instructions for a source whose Ask folder holds the given typology text; the operator's file, when one is named, takes its place. */
      readonly instructionsFor: (sourceTypology: string) => SummaryInstructions;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

interface LoadOptions {
  /** Only a test sets this, to a folder that stands in for the one shipped with the product. */
  readonly shippedDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type TextRead = { readonly text: string } | string;

/** One instruction text from the file the operator names or else the shipped one (none: no text, for a text the product ships none of); an empty prompt file is refused. */
export async function textOf(env: LoadOptions['env'], setting: string, shipped: { readonly path: string; readonly label: string } | undefined, isPrompt: boolean = setting === PROMPT_SETTING): Promise<TextRead> {
  const replacement = env?.[setting];
  if (replacement === undefined || replacement === '') return shipped === undefined ? { text: '' } : readText(shipped.path, shipped.label, ASK_FOLDER_LIMITS.classificationBytes);
  if (!replacement.startsWith('/')) return `${setting} must be an absolute path`;
  const read = await readText(replacement, setting, ASK_FOLDER_LIMITS.classificationBytes);
  if (isPrompt && typeof read !== 'string' && read.text.trim() === '') return `${setting}: the file is empty; the prompt carries the rules the model must follow`;
  return read;
}

/** The operator's typology file, read when its setting is set; undefined when it is not, so that the typology of the source's own folder is used. */
export async function typologyOverrideOf(env: LoadOptions['env'], setting: string): Promise<TextRead | undefined> {
  const named = env?.[setting];
  return named === undefined || named === '' ? undefined : textOf(env, setting, undefined, false);
}

/** The instructions of each typology text, built once: a source with no typology of its own shares the one with none. */
export function instructionsBuilder(prompt: string, override: string | undefined): (sourceTypology: string) => SummaryInstructions {
  const built = new Map<string, SummaryInstructions>();
  return (sourceTypology) => {
    const typology = override ?? sourceTypology;
    const found = built.get(typology) ?? buildSummaryInstructions(prompt, typology);
    built.set(typology, found);
    return found;
  };
}

/**
 * Reads the prompt from the file the operator names or else the one shipped with the product, and the typology text from the file the operator names (the product ships none: a pack may, and with no file there is no typology section). A problem names the setting or the shipped file with the setting that
 * replaces it, never a path or any text.
 */
export async function loadSummaryInstructions(options: LoadOptions = {}): Promise<InstructionsLoad> {
  const directory = options.shippedDirectory ?? SHIPPED_DIRECTORY;
  const prompt = await textOf(options.env, PROMPT_SETTING, { path: `${directory}${SHIPPED_PROMPT}`, label: `the shipped ${SHIPPED_PROMPT} (replace it with ${PROMPT_SETTING})` });
  const typology = await typologyOverrideOf(options.env, TYPOLOGY_SETTING);
  const problems = [prompt, typology].filter((found): found is string => typeof found === 'string');
  if (typeof prompt === 'string' || typeof typology === 'string') return { ok: false, problems };
  const instructionsFor = instructionsBuilder(prompt.text, typology?.text);
  return { ok: true, instructions: instructionsFor(''), instructionsFor };
}

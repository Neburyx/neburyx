import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PROMPT_IDS, type PromptId, type PromptParameters, type PromptRecord } from './provider.js';

/** `instructions` hold no parameter but the static ones, which are filled in from the mapping and the catalog and never from the investigation; `text` is the two parts joined by a blank line, which is the template as it was before it had parts, so its hash is unchanged. */
export interface BuiltInPrompt {
  readonly id: PromptId;
  readonly version: number;
  readonly parameters: readonly string[];
  /** The parameters that may appear in the instructions: fixed for a mapping and a catalog, so they are part of the cached prefix. */
  readonly staticParameters: readonly string[];
  readonly instructions: string;
  readonly values: string;
  readonly text: string;
}

/** The line of a replacement prompt that ends its instructions and begins its values. */
export const VALUES_BOUNDARY = '[[values]]';

const PART_SEPARATOR = '\n\n';

function builtIn(id: PromptId, parameters: readonly string[], instructions: string, values: string, version = 1, staticParameters: readonly string[] = []): BuiltInPrompt {
  return { id, version, parameters, staticParameters, instructions, values, text: `${instructions}${PART_SEPARATOR}${values}` };
}

export const BUILT_IN_PROMPTS: Readonly<Record<PromptId, BuiltInPrompt>> = {
  'ask.plan': builtIn(
    'ask.plan',
    ['catalog', 'vocabulary', 'patterns', 'question'],
    'Choose the one template from the catalog that answers the question, and give its parameters. Use only the template identifiers of the catalog and only the entity types, relationship types and derived rules of the vocabulary. The question holds placeholders in angle brackets in place of names and IDs: use them as the references and values they stand for, and never write a name or an ID of your own. Answer only with the plan as one JSON object with exactly these keys: "kind" (the text plan), "templateId" (the template identifier of the catalog), "templateVersion" (the version the catalog shows), "params" (the parameters as the catalog describes them) and "rationale" (one line). Answer with one JSON object with exactly these keys: "kind" (the text unsupported), "family" (one identifier from the list below) and "reason" (a short sentence), for a question that asks for a judgement, a question about what is shown on screen, and any question that neither a template of the catalog nor a saved pattern of the list answers. The family is exactly one of these identifiers, each followed by what it means: path: how two things are connected through a chain of links; property-selection: picking records by the value of a property; similar-records: records that look alike or nearly match; ranking-or-aggregate: a ranking, a total or another figure across many records; attribute-combination: several attributes combined at once; indirect-attribute: an attribute of a neighbouring record; unnamed-relation: a kind of link the source does not define; judgement: a judgement or conclusion; personal-data: personal details; loaded-view: what is shown on the screen; other: anything else that neither a template nor a listed saved pattern answers. A list of saved patterns may come before the question: when one of them answers it, you may answer with that pattern, in the same keys, in the form the list gives instead of a template of the catalog. Never write a query.\n\nCatalog:\n{{catalog}}\n\nVocabulary:\n{{vocabulary}}',
    '{{patterns}}Question:\n{{question}}',
    6,
    ['catalog', 'vocabulary'],
  ),
  'summary.view': builtIn(
    'summary.view',
    ['view'],
    'Draft a short, neutral summary of the view below. Every sentence must cite the keys it rests on, and the summary must say what the view does not show. Use only what the view holds.',
    'View:\n{{view}}',
  ),
  'assistant.route': builtIn(
    'assistant.route',
    ['message', 'view'],
    'Route the message to exactly one of three routes: an answer from the view, a plan to be confirmed, or a refusal. Answer only with the route and its content as structured data. Never write a query.',
    'View:\n{{view}}\n\nMessage:\n{{message}}',
  ),
  'ask.plan.repair': builtIn(
    'ask.plan.repair',
    ['catalog', 'vocabulary', 'patterns', 'question', 'reply', 'problems'],
    'Your earlier answer to the question could not be used as a plan. The problems are listed by path. Answer again with one JSON object with exactly these keys for a plan: "kind" (the text plan), "templateId" (the template identifier of the catalog), "templateVersion" (the version the catalog shows), "params" (the parameters as the catalog describes them) and "rationale" (one line), using only the template identifiers of the catalog and only the entity types, relationship types and derived rules of the vocabulary, and the placeholders of the question as the references and values they stand for. If neither a template of the catalog nor a saved pattern of the list answers the question, answer with one JSON object with exactly these keys: "kind" (the text unsupported), "family" (one identifier from the list below) and "reason" (a short sentence). The family is exactly one of these identifiers, each followed by what it means: path: how two things are connected through a chain of links; property-selection: picking records by the value of a property; similar-records: records that look alike or nearly match; ranking-or-aggregate: a ranking, a total or another figure across many records; attribute-combination: several attributes combined at once; indirect-attribute: an attribute of a neighbouring record; unnamed-relation: a kind of link the source does not define; judgement: a judgement or conclusion; personal-data: personal details; loaded-view: what is shown on the screen; other: anything else that neither a template nor a listed saved pattern answers. A saved pattern from the list before the question may be named in the form the list gives. Never write a query.',
    'Catalog:\n{{catalog}}\n\nVocabulary:\n{{vocabulary}}\n\n{{patterns}}Question:\n{{question}}\n\nYour earlier answer:\n{{reply}}\n\nProblems:\n{{problems}}',
    4,
  ),
};

export const MAX_OVERRIDE_BYTES = 64 * 1024;

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export class PromptError extends Error {}

/** `record.sha256` is the hash of the template (the built-in text, or the override file's text as it is), never of the text with the parameters filled in, so it names one version of a prompt and holds no user text. */
export interface ResolvedPrompt {
  readonly record: PromptRecord;
  /** The whole prompt with the parameters filled in: the two parts joined by a blank line when there are two. */
  readonly text: string;
  /** The fixed part, which holds no value; absent when the prompt does not declare where its instructions end. */
  readonly instructions?: string;
  /** What follows the fixed part, with the values filled in; the whole text when there is no fixed part. */
  readonly values: string;
}

export interface PromptRegistry {
  readonly resolve: (id: PromptId, values: PromptParameters) => ResolvedPrompt;
  /** Whether the text in use for the prompt (the built-in's, or the operator's file) has a place for the parameter. */
  readonly takes: (id: PromptId, parameter: string) => boolean;
}

export type PromptRegistryResult = { readonly ok: true; readonly registry: PromptRegistry } | { readonly ok: false; readonly problems: readonly string[] };

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function placeholdersOf(text: string): readonly string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

function isPromptId(id: string): id is PromptId {
  return PROMPT_IDS.some((known) => known === id);
}

function fillIn(text: string, values: PromptParameters): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => String(values[name]));
}

function checkValues(prompt: BuiltInPrompt, values: PromptParameters): void {
  for (const name of prompt.parameters) {
    if (!Object.hasOwn(values, name)) throw new PromptError(`the prompt ${prompt.id} needs the parameter ${name}`);
  }
  for (const name of Object.keys(values)) {
    if (!prompt.parameters.includes(name)) throw new PromptError(`the prompt ${prompt.id} has no parameter ${name}`);
  }
}

interface Override {
  readonly template: string;
  readonly instructions?: string;
  readonly values: string;
}

type OverrideLoad = { readonly ok: true; readonly override: Override } | { readonly ok: false; readonly problem: string };

function splitAtBoundary(text: string): { readonly instructions: string; readonly values: string } | 'none' | 'many' {
  const lines = text.split('\n');
  const at = lines.flatMap((line, index) => (line.replace(/\r$/, '') === VALUES_BOUNDARY ? [index] : []));
  if (at.length === 0) return 'none';
  if (at.length > 1) return 'many';
  const marker = at[0] ?? 0;
  return { instructions: lines.slice(0, marker).join('\n').trimEnd(), values: lines.slice(marker + 1).join('\n').trimStart() };
}

async function loadOverride(prompt: BuiltInPrompt, path: string): Promise<OverrideLoad> {
  const where = `ai.prompts.${prompt.id}`;
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return { ok: false, problem: `${where}: the file ${code === 'ENOENT' ? 'does not exist' : 'cannot be read'}` };
  }
  if (bytes.length > MAX_OVERRIDE_BYTES) return { ok: false, problem: `${where}: the file is larger than ${MAX_OVERRIDE_BYTES} bytes` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, problem: `${where}: the file is not valid UTF-8 text` };
  }
  if (text.trim() === '') return { ok: false, problem: `${where}: the file is empty` };
  const unknown = placeholdersOf(text).find((name) => !prompt.parameters.includes(name));
  if (unknown !== undefined) return { ok: false, problem: `${where}: the file uses the parameter ${unknown}, which the prompt does not have` };
  const split = splitAtBoundary(text);
  if (split === 'none') return { ok: true, override: { template: text, values: text } };
  if (split === 'many') return { ok: false, problem: `${where}: the file has more than one ${VALUES_BOUNDARY} line` };
  if (split.instructions === '') return { ok: false, problem: `${where}: the text before the ${VALUES_BOUNDARY} line is empty` };
  if (split.values === '') return { ok: false, problem: `${where}: the text after the ${VALUES_BOUNDARY} line is empty` };
  if (placeholdersOf(split.instructions).some((name) => !prompt.staticParameters.includes(name))) return { ok: false, problem: `${where}: the text before the ${VALUES_BOUNDARY} line uses a parameter that is not static, and would put a value in the cached part` };
  return { ok: true, override: { template: text, instructions: split.instructions, values: split.values } };
}

/** Every problem is collected; a file's text is never part of a problem. */
export async function buildPromptRegistry(overrides: Readonly<Record<string, string>> = {}): Promise<PromptRegistryResult> {
  const problems: string[] = [];
  const chosen = new Map<PromptId, Override>();
  for (const [id, path] of Object.entries(overrides)) {
    if (!isPromptId(id)) {
      problems.push(`ai.prompts: ${id} is not a built-in prompt (${PROMPT_IDS.join(', ')})`);
      continue;
    }
    const loaded = await loadOverride(BUILT_IN_PROMPTS[id], path);
    if (loaded.ok) chosen.set(id, loaded.override);
    else problems.push(loaded.problem);
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    registry: {
      takes(id, parameter) {
        const prompt = BUILT_IN_PROMPTS[id];
        return placeholdersOf(chosen.get(id)?.template ?? prompt.text).includes(parameter);
      },
      resolve(id, values) {
        const prompt = BUILT_IN_PROMPTS[id];
        checkValues(prompt, values);
        const override = chosen.get(id);
        const source = override ?? { template: prompt.text, instructions: prompt.instructions, values: prompt.values };
        const filledValues = fillIn(source.values, values);
        const record: PromptRecord = { id, version: prompt.version, source: override === undefined ? 'builtin' : 'override', sha256: sha256Of(source.template) };
        if (source.instructions === undefined) return { record, text: filledValues, values: filledValues };
        const instructions = fillIn(source.instructions, values);
        const filled: PromptRecord = placeholdersOf(source.instructions).length === 0 ? record : { ...record, instructionsSha256: sha256Of(instructions) };
        return { record: filled, text: `${instructions}${PART_SEPARATOR}${filledValues}`, instructions, values: filledValues };
      },
    },
  };
}

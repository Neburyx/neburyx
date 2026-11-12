import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PROMPT_IDS, type PromptId, type PromptParameters, type PromptRecord } from './provider.js';

export interface BuiltInPrompt {
  readonly id: PromptId;
  readonly version: number;
  readonly parameters: readonly string[];
  readonly text: string;
}

export const BUILT_IN_PROMPTS: Readonly<Record<PromptId, BuiltInPrompt>> = {
  'ask.plan': {
    id: 'ask.plan',
    version: 1,
    parameters: ['catalog', 'question'],
    text: 'Choose the one template from the catalog that answers the question, and give its parameters. Answer only with the plan as structured data. Never write a query.\n\nCatalog:\n{{catalog}}\n\nQuestion:\n{{question}}',
  },
  'summary.view': {
    id: 'summary.view',
    version: 1,
    parameters: ['view'],
    text: 'Draft a short, neutral summary of the view below. Every sentence must cite the keys it rests on, and the summary must say what the view does not show. Use only what the view holds.\n\nView:\n{{view}}',
  },
  'assistant.route': {
    id: 'assistant.route',
    version: 1,
    parameters: ['message', 'view'],
    text: 'Route the message to exactly one of three routes: an answer from the view, a plan to be confirmed, or a refusal. Answer only with the route and its content as structured data. Never write a query.\n\nView:\n{{view}}\n\nMessage:\n{{message}}',
  },
};

export const MAX_OVERRIDE_BYTES = 64 * 1024;

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export class PromptError extends Error {}

/** `record.sha256` is the hash of the template (the built-in text, or the override file's text as it is), never of the text with the parameters filled in, so it names one version of a prompt and holds no user text. */
export interface ResolvedPrompt {
  readonly record: PromptRecord;
  readonly text: string;
}

export interface PromptRegistry {
  readonly resolve: (id: PromptId, values: PromptParameters) => ResolvedPrompt;
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

type OverrideLoad = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string };

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
  return { ok: true, text };
}

/** Every problem is collected; a file's text is never part of a problem. */
export async function buildPromptRegistry(overrides: Readonly<Record<string, string>> = {}): Promise<PromptRegistryResult> {
  const problems: string[] = [];
  const texts = new Map<PromptId, string>();
  for (const [id, path] of Object.entries(overrides)) {
    if (!isPromptId(id)) {
      problems.push(`ai.prompts: ${id} is not a built-in prompt (${PROMPT_IDS.join(', ')})`);
      continue;
    }
    const loaded = await loadOverride(BUILT_IN_PROMPTS[id], path);
    if (loaded.ok) texts.set(id, loaded.text);
    else problems.push(loaded.problem);
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    registry: {
      resolve(id, values) {
        const prompt = BUILT_IN_PROMPTS[id];
        checkValues(prompt, values);
        const override = texts.get(id);
        const template = override ?? prompt.text;
        const text = fillIn(template, values);
        return { record: { id, version: prompt.version, source: override === undefined ? 'builtin' : 'override', sha256: sha256Of(template) }, text };
      },
    },
  };
}

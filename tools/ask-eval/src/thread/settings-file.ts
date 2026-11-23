import { readFileSync } from 'node:fs';
import { UsageError } from '../questions.js';

/**
 * The only names the tool reads from the env file the product was started with: the settings of the assistant and the effort of the model. Nothing else in the file is read, kept or printed, so a key, a path of a secret
 * or a connection string in it never reaches the tool's memory or output.
 */
const ALLOWED = [
  'NEBURYX_ASSISTANT_MODEL',
  'NEBURYX_ASSISTANT_TIMEOUT_MS',
  'NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS',
  'NEBURYX_ASSISTANT_MAX_CALLS',
  'NEBURYX_ASSISTANT_MAX_STEPS',
  'NEBURYX_ASSISTANT_MAX_ROWS',
  'NEBURYX_ASSISTANT_CONTEXT_TURNS',
  'NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS',
  'NEBURYX_ASSISTANT_MAX_INPUT_TOKENS',
  'NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS',
  'NEBURYX_ASK_EFFORT',
] as const;

export type AllowedName = (typeof ALLOWED)[number];

/** The allowlisted settings the file names, with the surrounding quotes taken off; a name the file does not set is absent (the product's default applies). */
export function readSettingsFile(path: string): Readonly<Partial<Record<AllowedName, string>>> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError('the settings file cannot be read');
  }
  const found: Partial<Record<AllowedName, string>> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const name = trimmed.slice(0, at).trim().replace(/^export\s+/u, '');
    const known = ALLOWED.find((allowed) => allowed === name);
    if (known !== undefined) found[known] = trimmed.slice(at + 1).trim().replace(/^["']|["']$/gu, '');
  }
  return found;
}

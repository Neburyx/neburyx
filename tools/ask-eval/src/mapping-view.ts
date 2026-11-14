import { readFileSync } from 'node:fs';
import { aiSettingsSchema, type AiMappingView, type AiSettings } from '@neburyx/contracts';
import { parse } from 'yaml';
import { loadMappingFile } from '../../../services/api/dist/mapping/load.js';
import { aiMappingViewOf } from '../../../services/api/dist/profile/mapping-view.js';
import type { ScoreContext } from './score.js';

export class MappingBudgetError extends Error {}

/** The `ai` settings from a file of their own (outside the checkout): either the settings themselves or a file with an `ai` section. */
export function loadAiFile(path: string): AiSettings {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch {
    // the library quotes a piece of the source line in its message, and the file may be the wrong one
    throw new Error('the ai settings file could not be read');
  }
  const given = typeof parsed === 'object' && parsed !== null && 'ai' in parsed ? parsed.ai : parsed;
  const checked = aiSettingsSchema.safeParse(given);
  if (!checked.success) throw new Error('the ai settings file is malformed');
  return checked.data;
}

export function loadAiSettings(path: string): AiSettings | undefined {
  return loadMappingFile(path).ai;
}

export function loadMapping(path: string): { readonly view: AiMappingView; readonly context: ScoreContext } {
  const model = loadMappingFile(path);
  const pages = new Set(model.sources.map((source) => source.budgets.defaultPage));
  const [defaultPage] = [...pages];
  if (pages.size !== 1 || defaultPage === undefined) throw new MappingBudgetError('the mapping sets more than one default page');
  const view = aiMappingViewOf(model);
  return { view, context: { view, defaultPage } };
}

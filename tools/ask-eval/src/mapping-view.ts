import type { AiMappingView } from '@neburyx/contracts';
import { loadMappingFile } from '../../../services/api/dist/mapping/load.js';
import { aiMappingViewOf } from '../../../services/api/dist/profile/mapping-view.js';
import type { ScoreContext } from './score.js';

export class MappingBudgetError extends Error {}

export function loadMapping(path: string): { readonly view: AiMappingView; readonly context: ScoreContext } {
  const model = loadMappingFile(path);
  const pages = new Set(model.sources.map((source) => source.budgets.defaultPage));
  const [defaultPage] = [...pages];
  if (pages.size !== 1 || defaultPage === undefined) throw new MappingBudgetError('the mapping sets more than one default page');
  const view = aiMappingViewOf(model);
  return { view, context: { view, defaultPage } };
}

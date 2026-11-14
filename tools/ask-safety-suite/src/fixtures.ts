import { createHash } from 'node:crypto';
import type { AskFolder, AskIntent } from '@neburyx/contracts';
import { makeAskFolder } from '../../../services/api/src/testing/ask-folder.js';

/** The text of the folder's one file query: it is checked exactly against what the executor receives. */
export const FILE_QUERY = 'MATCH (n:Widget) WHERE n.widgetId = $id RETURN n LIMIT 5';

/** One template intent that takes an ID, one that takes search text, and one file query. */
const INTENTS = {
  widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } },
  findWidgets: { parameters: ['q'], template: 'search', settings: { entityTypes: ['widget'], text: '$q' } },
  byId: { parameters: ['id'], query: FILE_QUERY },
};

/** The text `makeAskFolder` writes as `classification.md`. */
export const CLASSIFICATION = 'Choose the intent that answers the question.';

export const reply = (intent: string | null, entities: Record<string, unknown> = {}): string => JSON.stringify({ intent, entities });

export const folderOf = (intents: unknown = INTENTS): string => makeAskFolder(['demo'], intents);

/** A template intent that reaches the heavy stop on the mapping of the shared-attribute fixtures. */
export const SHARED_INTENTS = {
  sharedWith: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'maker', stableId: '$id' }, attributeType: 'tool', via: 'USES_TOOL' } },
};

/** A folder object built by hand, holding the given queries: the way a query is forced past the loader. */
export function handFolder(queries: Readonly<Record<string, string>>): AskFolder {
  const intents: AskIntent[] = Object.entries(queries).map(([name, text]) => ({ name, parameters: ['id'], kind: 'query', query: { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') } }));
  return { sourceIds: ['demo'], source: () => ({ classification: { text: CLASSIFICATION, sha256: '' }, intents }), intent: (_sourceId, name) => intents.find((candidate) => candidate.name === name) };
}

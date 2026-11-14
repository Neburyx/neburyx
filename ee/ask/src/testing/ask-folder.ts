import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** The intents of the test folders: one query intent and one template intent. */
const TEST_INTENTS = { byId: { parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' }, shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } } };

/** A valid Ask folder with a subfolder for each source id, in a temporary place; `removeAskFolders` deletes every one made. */
export function makeAskFolder(sourceIds: readonly string[], intents: unknown = TEST_INTENTS): string {
  const root = mkdtempSync(join(tmpdir(), 'ask-folder-'));
  made.push(root);
  for (const id of sourceIds) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'classification.md'), 'Choose the intent that answers the question.');
    writeFileSync(join(root, id, 'intents.json'), JSON.stringify(intents));
  }
  return root;
}

export function removeAskFolders(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** The intents of the test folders: one query intent and one template intent. */
const TEST_INTENTS = { byId: { parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' }, shared: { parameters: ['ref'], template: 'shared-attribute', settings: { attributeType: 'shape' } } };

/** A valid Ask folder with a subfolder for each source id, in a temporary place; `removeAskFolders` deletes every one made. */
export function makeAskFolder(sourceIds: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ask-folder-'));
  made.push(root);
  for (const id of sourceIds) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'classification.md'), 'Choose the intent that answers the question.');
    writeFileSync(join(root, id, 'intents.json'), JSON.stringify(TEST_INTENTS));
  }
  return root;
}

export function removeAskFolders(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

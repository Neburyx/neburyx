import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

const DEFAULT_INTENTS = { byId: { parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' } };

/** A valid Ask folder with a subfolder for each source id (none for a mapping with no source), in a temporary place; `removeAskFolders` deletes every one made. */
export function makeAskFolder(sourceIds: readonly string[] = [], intents: unknown = DEFAULT_INTENTS): string {
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

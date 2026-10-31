import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const INDEX_HTML = '<!doctype html><title>fixture</title>';
export const V1_FILE = 'served from the v1 folder of the web build';
export const APP_JS = 'export const fixture = true;';

export function makeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'web-root-'));
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'v1'));
  writeFileSync(join(root, 'index.html'), INDEX_HTML);
  writeFileSync(join(root, 'assets', 'app.js'), APP_JS);
  writeFileSync(join(root, 'v1', 'secret.txt'), V1_FILE);
  writeFileSync(join(root, 'v1', 'index.html'), V1_FILE);
  return root;
}

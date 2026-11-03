import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Compose } from './compose.js';
import { dockerEnvironment } from './environments.js';
import { run, type Run } from './exec.js';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function copyOfTheComposeFiles(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-down-'));
  folders.push(root);
  for (const path of ['deploy/demo/compose.yaml', 'deploy/demo/compose.dev.yaml', 'deploy/compose/compose.yaml', 'deploy/compose/initdb']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repository, path), join(root, path), { recursive: true });
  }
  return root;
}

describe('removing the project with real Docker Compose', () => {
  it('works with no .env, ignores a malformed .env in the demo folder that Compose would otherwise load, and prints no value from it', async () => {
    const root = copyOfTheComposeFiles();
    writeFileSync(join(root, 'deploy/demo/.env'), 'DEMO_NEO4J_PASSWORD="an unclosed quote SECRETVALUE\nNEBURYX_CURSOR_KEY=SECRETVALUE\n');
    const output: string[] = [];
    const capture: Run = async (command, args, options) => {
      const result = await run(command, args, { ...options, show: false });
      output.push(result.stdout, result.stderr);
      return result;
    };
    await new Compose(capture, root, dockerEnvironment(process.env)).down();
    expect(output.join('\n')).not.toContain('SECRETVALUE');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAiFile } from './mapping-view.js';

const folder = mkdtempSync(join(tmpdir(), 'ai-file-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function file(text: string): string {
  const path = join(folder, `f-${Math.random().toString(16).slice(2)}.yaml`);
  writeFileSync(path, text);
  return path;
}

describe('the ai settings file of a recording run', () => {
  it('loads the settings given directly, and the settings under an ai section', () => {
    const direct = loadAiFile(file('provider: anthropic\nmodel: model-one\nkey:\n  file: /somewhere/key\n'));
    const sectioned = loadAiFile(file('ai:\n  provider: anthropic\n  model: model-one\n  key:\n    file: /somewhere/key\n'));
    expect(direct).toEqual(sectioned);
    expect(direct).toMatchObject({ provider: 'anthropic', model: 'model-one', key: { file: '/somewhere/key' } });
  });

  it('refuses settings that do not match the schema, with a message that holds none of the file', () => {
    expect(() => loadAiFile(file('provider: SECRET-PROVIDER\nunknown_setting: 1\n'))).toThrow('the ai settings file is malformed');
    try {
      loadAiFile(file('provider: SECRET-PROVIDER\n'));
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });

  it('refuses a file that is not valid YAML without quoting any of its text', () => {
    try {
      loadAiFile(file('sk-test-SENTINEL: [unclosed\n  : : bad\n'));
      throw new Error('it did not refuse');
    } catch (error) {
      expect(String(error)).toContain('could not be read');
      expect(String(error)).not.toContain('SENTINEL');
    }
  });
});

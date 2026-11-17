// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace.js';

const FOLDERS = ['deploy/compose', 'deploy/demo', 'deploy/docker', 'deploy/release', '.github/workflows'];

function files(folder: string): string[] {
  return readdirSync(join(repoRoot, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe('the dev reload of the mapping file', () => {
  it('is set by none of the files that ship or run a release: the compose files, the image and its entrypoint, the release files and the workflows', () => {
    const holding = FOLDERS.flatMap(files).filter((path) => readFileSync(join(repoRoot, path), 'utf8').split('\n').some((line) => /NEBURYX_DEV\b/.test(line) && !line.trim().startsWith('#')));
    expect(holding).toEqual([]);
  });

  it('is described, commented out, in the example settings files that the compose files read', () => {
    {
      const path = '.env.example';
      const lines = readFileSync(join(repoRoot, path), 'utf8').split('\n').filter((line) => /NEBURYX_DEV\b/.test(line));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.startsWith('#')).toBe(true);
    }
  });
});

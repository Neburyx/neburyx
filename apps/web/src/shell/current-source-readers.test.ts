// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const READS_SOURCE_OF_INVESTIGATION = /investigation\)?\s*,\s*\(\w+\)\s*=>\s*\w+\.sourceId|investigation\.getState\(\)\.sourceId/;
const SHOWS_THE_SOURCE = 'shell/use-current-source.ts';
const KEYS_BEHAVIOUR_TO_THE_SOURCE = ['canvas/profile-context.tsx', 'canvas/profile-store.ts', 'canvas/graph-canvas.tsx', 'workspace/legend-panel.tsx', 'workspace/panel-resize.ts', 'search/add-tab.tsx', 'patterns/patterns-panel.tsx'];
const CHOOSES_THE_SOURCE_OF_A_SEARCH_WITHOUT_ONE = ['search/search-page.tsx', 'home/home-search.tsx'];
const NAMES_THE_SOURCE_IN_AN_EXPORT = ['exports/export-dialog.tsx'];
const ALLOWED = new Set([SHOWS_THE_SOURCE, ...NAMES_THE_SOURCE_IN_AN_EXPORT, ...CHOOSES_THE_SOURCE_OF_A_SEARCH_WITHOUT_ONE, ...KEYS_BEHAVIOUR_TO_THE_SOURCE]);

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'state' ? [] : productionFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('test-utils.tsx') ? [path] : [];
  });
}

describe('the source on screen', () => {
  it('is read from the state of the investigation only by the one reader that shows it and by the files that key their behaviour to it, so a new reader has to be added here on purpose', () => {
    const readers = productionFiles(SRC)
      .filter((path) => READS_SOURCE_OF_INVESTIGATION.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((path) => !ALLOWED.has(path));
    expect(readers).toEqual([]);
  });

  it('is read by the header, the status line and the page heading through useCurrentSource', () => {
    for (const file of ['workspace/header-source.tsx', 'shell/source-line.tsx', 'shell/page-heading.tsx']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toContain('useCurrentSource');
    }
  });
});

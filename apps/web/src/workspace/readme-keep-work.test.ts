// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOOTNOTE, EXPORT_BUTTON, EXPORT_DISABLED_SOURCE, EXPORT_TITLE, downloadLabel, FORMAT_NAMES } from '../exports/copy.js';
import { COLUMN_COUNTS, COLUMN_EDITED, COLUMN_ENTITY, COLUMN_SOURCE, COLUMN_TITLE, COLUMN_ACTIONS, DELETED_CHIP, OPEN, PAGE_TITLE, RESTORE, ROW_MENU_BUTTON } from '../investigations-page/copy.js';
import { ARCHIVE, CLOSE, CLOSED_HEADLINE, CLOSED_PILL, DELETE, DELETE_INVESTIGATION, DELETE_TITLE, REOPEN, RENAME } from '../lifecycle/copy.js';
import { NAVIGATION } from '../shell/navigation.js';

const root = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
const readme = root('README.md').replace(/\s+/g, ' ');

describe('the README part about keeping the work', () => {
  it('quotes the sidebar entry, the page columns, the row menu and its items as the web app writes them', () => {
    expect(NAVIGATION.map((item) => item.label)).toContain(PAGE_TITLE);
    for (const phrase of [PAGE_TITLE, COLUMN_TITLE, COLUMN_ENTITY, COLUMN_SOURCE, COLUMN_EDITED, COLUMN_COUNTS, COLUMN_ACTIONS, OPEN, RENAME, CLOSE, REOPEN, ARCHIVE, DELETE]) expect(readme).toContain(`"${phrase}"`);
    expect(ROW_MENU_BUTTON('x')).toBe('Actions for x');
    expect(readme).toContain('"Actions for" and the title');
  });

  it('quotes the close, reopen, delete and restore words as the web app writes them', () => {
    expect(readme).toContain(`"${CLOSED_PILL}"`);
    for (const phrase of [CLOSED_HEADLINE, DELETE_TITLE, DELETE_INVESTIGATION, DELETED_CHIP, RESTORE, REOPEN]) expect(readme).toContain(phrase);
  });

  it('quotes the export button, dialog, formats, footnote and the refusal as the web app writes them', () => {
    for (const phrase of [EXPORT_BUTTON, EXPORT_TITLE, FORMAT_NAMES.json, FORMAT_NAMES.csv, downloadLabel('json'), downloadLabel('csv'), FOOTNOTE, EXPORT_DISABLED_SOURCE]) expect(readme).toContain(phrase);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkPatternEvents, PATTERN_EVENT_SCAN_ROOTS } from './pattern-events.js';
import { loadTree } from './tree.js';
import { formatViolations } from './violations.js';

const check = (text: string, path = 'services/api/src/patterns/a.ts') => checkPatternEvents([{ path, text }]);

describe('a statement that changes or removes a pattern event', () => {
  it.each([
    ['UPDATE pattern_events SET pattern_version = 2', 'UPDATE pattern_events'],
    ['update  public.pattern_events set x = 1', 'UPDATE pattern_events'],
    ['UPDATE ONLY "pattern_events" SET x = 1', 'UPDATE pattern_events'],
    ['DELETE FROM pattern_events WHERE id = $1', 'DELETE FROM pattern_events'],
    ['delete\n  from "public"."pattern_events"', 'DELETE FROM pattern_events'],
    ['TRUNCATE pattern_events', 'TRUNCATE pattern_events'],
    ['truncate table public.pattern_events', 'TRUNCATE pattern_events'],
  ])('is reported: %s', (text, label) => {
    expect(check(`const q = \`${text}\`;`)).toMatchObject([{ rule: 'pattern-events', file: 'services/api/src/patterns/a.ts', line: 1, specifier: label }]);
  });

  it('is reported with its line', () => {
    expect(check('const a = 1;\n\nawait c.query("DELETE FROM pattern_events");')).toMatchObject([{ line: 3 }]);
  });
});

describe('what is not a change of a pattern event', () => {
  it.each([
    'INSERT INTO pattern_events (id) VALUES ($1)',
    'SELECT id FROM pattern_events WHERE pattern_id = $1',
    'UPDATE saved_patterns SET name = $1',
    'DELETE FROM pattern_events_archive',
    'UPDATE other_pattern_events SET x = 1',
  ])('is not reported: %s', (text) => {
    expect(check(`const q = '${text}';`)).toEqual([]);
  });

  it('is not reported in a test file or in the test support folder, which prove the table refuses it', () => {
    expect(check('UPDATE pattern_events SET x = 1', 'services/api/src/patterns/a.integration.test.ts')).toEqual([]);
    expect(check('UPDATE pattern_events SET x = 1', 'services/api/src/testing/rig.ts')).toEqual([]);
  });
});

describe('the repository', () => {
  it('has no code that updates, deletes or truncates a pattern event', () => {
    const files = loadTree(repoRoot, { include: PATTERN_EVENT_SCAN_ROOTS });
    expect(files.length).toBeGreaterThan(100);
    expect(formatViolations(checkPatternEvents(files))).toBe('');
  });
});

describe('the documentation of the check', () => {
  it('names the check, the files it scans and the statements it refuses', () => {
    const text = readFileSync(join(repoRoot, 'docs/architecture-checks.md'), 'utf8');
    const section = text.slice(text.indexOf('## Pattern events'));
    expect(section).toContain('tools/workspace-checks/src/architecture/pattern-events.ts');
    for (const word of ['`UPDATE`', '`DELETE FROM`', '`TRUNCATE`', '`services/`']) expect(section).toContain(word);
    expect(text).toContain('A fifth, [pattern events](#pattern-events)');
  });
});

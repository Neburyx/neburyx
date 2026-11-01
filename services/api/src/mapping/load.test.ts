import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSeq, LineCounter, parseDocument } from 'yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { baseSource, expectRefused, fileOf, firstSource, issuesOf, load, REFUSED_MARKER, REFUSED_YAML } from '../testing/mapping.js';
import { MappingError } from './diagnostics.js';
import { loadMappingFile, MAX_MAPPING_BYTES, parseMapping } from './load.js';
import { nodeProblems } from './subset.js';

const folder = mkdtempSync(join(tmpdir(), 'mapping-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('loading a mapping file', () => {
  it('names the path of a file that cannot be read', () => {
    const missing = join(folder, 'missing.yaml');
    expect(() => loadMappingFile(missing)).toThrow(MappingError);
    expect(() => loadMappingFile(missing)).toThrow(missing);
  });

  it('reads a file from disk', () => {
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(baseSource()));
    expect(loadMappingFile(file).sources).toHaveLength(1);
  });

  it('names the line and column of a YAML syntax error', () => {
    const issues = issuesOf('sources:\n  - id: demo\n   bad: indent\n');
    expect(issues[0]?.line).toBeGreaterThan(0);
    expect(issues[0]?.column).toBeGreaterThan(0);
    expect(issues[0]?.reason).toContain('is not valid YAML');
  });

  it('refuses a key that appears twice', () => {
    expect(issuesOf('sources: []\nsources: []\n')[0]?.reason).toContain('is not valid YAML');
  });

  it('refuses a file larger than the size limit', () => {
    expect(() => parseMapping(' '.repeat(MAX_MAPPING_BYTES + 1), 'neburyx.yaml')).toThrow('larger than');
  });

  it('refuses an empty file', () => {
    expect(issuesOf('')[0]?.path).toBe('');
  });

  it('accepts a file that lists no sources', () => {
    expect(parseMapping('sources: []\n', 'neburyx.yaml').sources).toEqual([]);
  });
});

describe('a minimal mapping', () => {
  it('fills every default from the entity type, label and stable ID alone', () => {
    const source = firstSource(load(baseSource({ relationships: undefined })));
    const [entity] = source.entities;
    expect(entity).toMatchObject({
      type: 'node_a',
      label: 'NodeA',
      stableId: 'id',
      title: '{id}',
      titleProperties: ['id'],
      search: [],
      reference: [],
      pii: [],
      filterable: [],
      display: { icon: 'generic', keyProperties: ['id'] },
    });
    expect(source.synthetic).toBe(false);
    expect(source.relationships).toEqual([]);
    expect(source.derived).toEqual([]);
    expect(source.styleRules).toEqual([]);
  });

  it('holds the environment variable names and never reads their values', () => {
    const before = process.env['DEMO_PASSWORD'];
    process.env['DEMO_PASSWORD'] = 'unit-test-secret-value';
    try {
      const source = firstSource(load(baseSource()));
      expect(source.auth).toEqual({ usernameEnv: 'DEMO_USER', passwordEnv: 'DEMO_PASSWORD' });
      expect(JSON.stringify(source)).not.toContain('unit-test-secret-value');
    } finally {
      if (before === undefined) delete process.env['DEMO_PASSWORD'];
      else process.env['DEMO_PASSWORD'] = before;
    }
  });
});

describe('unknown keys', () => {
  it('names an unknown key at the top level', () => {
    const text = `${fileOf(baseSource())}extra: 1\n`;
    expect(issuesOf(text).map((issue) => issue.path)).toContain('extra');
  });

  it('names an unknown key in a source with its position', () => {
    const issue = expectRefused(baseSource({ colour: 'blue' }), 'sources[0].colour', 'is not a known key');
    expect(issue.line).toBeGreaterThan(0);
  });

  it('names an unknown key in an entity', () => {
    expectRefused(
      baseSource({ entities: [{ type: 'node_a', label: 'NodeA', stable_id: 'id', labell: 'x' }] }),
      'sources[0].entities[0].labell',
      'is not a known key',
    );
  });

  it.each([
    ['auth', { auth: { kind: 'basic', username_env: 'U', password_env: 'P', extra: true } }, 'sources[0].auth.extra'],
    ['display', { entities: [{ type: 'a', label: 'A', stable_id: 'id', display: { icon: 'generic', shape: 'x' } }] }, 'sources[0].entities[0].display.shape'],
    ['budgets', { budgets: { timeout_ms: 100, speed: 1 } }, 'sources[0].budgets.speed'],
    ['relationship', { relationships: [{ type: 'L', from: 'node_a', to: 'node_b', weight: 1 }] }, 'sources[0].relationships[0].weight'],
    ['derived rule', { derived: [{ id: 'r', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1, note: 'x' }] }, 'sources[0].derived[0].note'],
    ['preset', { patterns: [{ id: 'p', name: 'P', template: 'shared-attribute', bind: {}, note: 'x' }] }, 'sources[0].patterns[0].note'],
    ['vocabulary', { vocabulary: { case_ref: 'Ref', other: 'x' } }, 'sources[0].vocabulary.other'],
  ])('names an unknown key inside %s', (_name, overrides, path) => {
    expectRefused(baseSource(overrides), path, 'is not a known key');
  });
});

describe('duplicate sources', () => {
  it('names a source ID that appears twice', () => {
    const issues = issuesOf(fileOf(baseSource(), baseSource()));
    expect(issues.some((issue) => issue.path === 'sources[1].id' && issue.reason.includes('demo'))).toBe(true);
  });
});

describe('required keys and shapes', () => {
  it.each([
    ['a missing uri', { uri: undefined }, 'sources[0].uri', 'is required'],
    ['a missing database', { database: undefined }, 'sources[0].database', 'is required'],
    ['a missing auth block', { auth: undefined }, 'sources[0].auth', 'is required'],
    ['entities that is not a list', { entities: 'none' }, 'sources[0].entities', 'must be array'],
    ['an empty entity list', { entities: [] }, 'sources[0].entities', 'must not be empty'],
    ['a missing stable ID', { entities: [{ type: 'a', label: 'A' }] }, 'sources[0].entities[0].stable_id', 'is required'],
    ['a stable ID of the wrong type', { entities: [{ type: 'a', label: 'A', stable_id: 4 }] }, 'sources[0].entities[0].stable_id', 'must be string'],
    ['search of the wrong type', { entities: [{ type: 'a', label: 'A', stable_id: 'id', search: 'id' }] }, 'sources[0].entities[0].search', 'must be array'],
    ['synthetic of the wrong type', { synthetic: 'yes' }, 'sources[0].synthetic', 'must be boolean'],
    ['an id with spaces', { id: 'bad id' }, 'sources[0].id', 'invalid format'],
  ])('names %s', (_name, overrides, path, reason) => {
    expectRefused(baseSource(overrides), path, reason);
  });

  it('refuses a file whose sources is not a list', () => {
    expect(issuesOf('sources: nope\n')[0]?.path).toBe('sources');
  });

  it('refuses a file that has no sources key', () => {
    expect(issuesOf('other: 1\n').map((issue) => issue.path)).toContain('sources');
  });
});

describe('the message of a refused mapping', () => {
  it('never repeats a uri, a credential name or any free-text value', () => {
    const source = baseSource({
      uri: 'neo4j+s://user:hunter2@secret-host.example.test:7687',
      auth: { kind: 'basic', username_env: 'SECRET_USER_VAR', password_env: 'bad value' },
      database: 'private-database-name',
      colour: 'blue-value',
    });
    let message = '';
    try {
      load(source);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('invalid mapping neburyx.yaml');
    for (const secret of ['hunter2', 'secret-host', 'SECRET_USER_VAR', 'bad value', 'private-database-name', 'blue-value']) {
      expect(message).not.toContain(secret);
    }
  });

  it('shows at most ten problems and counts the rest', () => {
    const entities = Array.from({ length: 14 }, (_unused, index) => ({ type: `t${index}`, label: 'L', stable_id: 'id', icon: 'x' }));
    let message = '';
    try {
      load(baseSource({ entities }));
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('and 4 more');
  });
});

describe('the accepted YAML subset', () => {
  it.each(REFUSED_YAML)('refuses %s with its place and without its value', (_name, text, reason) => {
    const issues = issuesOf(text);
    expect(issues.some((issue) => issue.reason.includes(reason))).toBe(true);
    expect(issues.some((issue) => issue.reason.includes(reason) && (issue.line ?? 0) > 0 && (issue.column ?? 0) > 0)).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(REFUSED_MARKER);
  });

  it('accepts flow and block mappings, sequences, the three string styles and comments', () => {
    const text = [
      '# comment',
      'sources:',
      '  - id: demo # trailing comment',
      "    uri: 'neo4j+s://graph.example.test:7687'",
      '    database: "neo4j"',
      '    auth: {kind: basic, username_env: DEMO_USER, password_env: DEMO_PASSWORD}',
      '    entities:',
      '      - {type: node_a, label: NodeA, stable_id: id, search: [name, code]}',
      '      - type: node_b',
      '        label: NodeB',
      '        stable_id: key',
      '',
    ].join('\n');
    expect(parseMapping(text, 'neburyx.yaml').sources[0]?.entities).toHaveLength(2);
  });

  it('accepts a full mapping that uses every section', () => {
    const source = baseSource({
      synthetic: true,
      budgets: { max_hops: 3 },
      vocabulary: { case_ref: 'Referral' },
      derived: [{ id: 'shared', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1 }],
      patterns: [{ id: 'p', name: 'P', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'LINKS' } }],
      style_rules: [{ id: 'r', nested: [1, 'two', true, null] }],
    });
    expect(parseMapping(fileOf(source), 'neburyx.yaml').sources).toHaveLength(1);
  });
});

describe('hostile input', () => {
  it('reports a flood of aliases as a mapping problem, not a crash', () => {
    const anchors = Array.from({ length: 200 }, () => '*a').join(', ');
    const text = `${fileOf(baseSource())}    style_rules: [&a [1], ${anchors}]\n`;
    expect(issuesOf(text).some((issue) => issue.reason.includes('uses an alias'))).toBe(true);
  });

  it('reports very deep nesting instead of crashing', () => {
    const text = `${fileOf(baseSource())}    style_rules: ${'['.repeat(100_000)}${']'.repeat(100_000)}\n`;
    expect(issuesOf(text).length).toBeGreaterThan(0);
  });

  it('reads at most the size limit from disk and refuses a larger file', () => {
    const file = join(folder, 'huge.yaml');
    writeFileSync(file, `# ${'x'.repeat(MAX_MAPPING_BYTES + 10)}\nsources: []\n`);
    expect(() => loadMappingFile(file)).toThrow('larger than');
  });

  it('names the path of a directory that is not a file', () => {
    expect(() => loadMappingFile(folder)).toThrow(folder);
  });

  it('refuses a key that is a number or a flag', () => {
    expect(issuesOf(`${fileOf(baseSource())}    1: x\n`).some((issue) => issue.reason === 'has a key that is not text')).toBe(true);
  });

  it('does not emit a parser warning for a collection key', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      issuesOf(`${fileOf(baseSource())}    ? {uri: x}\n    : x\n`);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports hostile top-level and nested keys by name and pollutes nothing', () => {
    const text = `${fileOf(baseSource())}    __proto__: {polluted: yes}\n    constructor: {prototype: {polluted: yes}}\n`;
    const paths = issuesOf(text).map((issue) => issue.path);
    expect(paths).toContain('sources[0].__proto__');
    expect(paths).toContain('sources[0].constructor');
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
  });
});

describe('the node allowlist', () => {
  it('refuses a node type it does not list, with no value', () => {
    const problems = nodeProblems({ kind: 'unlisted', value: 'SUPPLIED_MARKER' }, new LineCounter());
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBeUndefined();
    expect(problems[0]?.reason).toBe('uses a construct a mapping does not allow');
    expect(JSON.stringify(problems)).not.toContain('SUPPLIED_MARKER');
  });

  it('gives the place of an unlisted node type when it has a range', () => {
    const lines = new LineCounter();
    lines.addNewLine(0);
    lines.addNewLine(10);
    const problems = nodeProblems({ range: [12, 13, 13] }, lines);
    expect(problems[0]).toMatchObject({ line: 2, column: 3 });
  });

  it('refuses an unlisted node type nested inside a sequence', () => {
    const document = parseDocument('[1]', { lineCounter: new LineCounter() });
    if (!isSeq(document.contents)) throw new Error('expected a sequence');
    document.contents.items.push(Object.assign(Object.create(null), { odd: true }));
    expect(nodeProblems(document.contents, new LineCounter()).some((problem) => problem.reason.includes('construct'))).toBe(true);
  });

  it('accepts a declaration of YAML 1.2', () => {
    expect(parseMapping(`%YAML 1.2\n---\n${fileOf(baseSource())}`, 'neburyx.yaml').sources).toHaveLength(1);
  });
});

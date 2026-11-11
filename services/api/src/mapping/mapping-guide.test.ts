import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PII_CLASSES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DOCS_FOLDER, GUIDE_PATH, guideBlocks, guideTable, guideText, unticked } from '../testing/guide.js';
import { BUDGET_DEFAULTS, budgetsSchema } from './budgets.js';
import { MappingError } from './diagnostics.js';
import { parseMapping } from './load.js';
import { RETENTION_DEFAULTS, retentionSchema } from './retention.js';
import { mappingFileSchema } from './schema.js';

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) current = current.unwrap() as z.ZodType;
    else if (current instanceof z.ZodArray) current = current.element as z.ZodType;
    else return current;
  }
}

function child(schema: z.ZodType, key: string): z.ZodType {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) throw new Error('not an object');
  const found = (inner.shape as Record<string, z.ZodType>)[key];
  if (found === undefined) throw new Error(`no key ${key}`);
  return found;
}

function keysOf(schema: z.ZodType): string[] {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) throw new Error('not an object');
  return Object.keys(inner.shape as Record<string, unknown>);
}

const SOURCE = child(mappingFileSchema, 'sources');
const ENTITY = child(SOURCE, 'entities');
const DEMO_CASE = child(SOURCE, 'demo_case');

const TABLES: readonly (readonly [string, z.ZodType])[] = [
  ['file', mappingFileSchema],
  ['retention', child(mappingFileSchema, 'retention')],
  ['source', SOURCE],
  ['auth', child(SOURCE, 'auth')],
  ['vocabulary', child(SOURCE, 'vocabulary')],
  ['demo_case', DEMO_CASE],
  ['demo_case.entity', child(DEMO_CASE, 'entity')],
  ['entity', ENTITY],
  ['display', child(ENTITY, 'display')],
  ['degree', child(ENTITY, 'degree')],
  ['relationship', child(SOURCE, 'relationships')],
  ['derived', child(SOURCE, 'derived')],
  ['pattern', child(SOURCE, 'patterns')],
];

describe('the examples in the guide', () => {
  const yamlBlocks = guideBlocks().filter((block) => block.info === 'yaml');
  const invalidBlocks = guideBlocks().filter((block) => block.info === 'yaml invalid');

  it('are there', () => {
    expect(yamlBlocks.length).toBeGreaterThanOrEqual(5);
    expect(invalidBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it.each(yamlBlocks.map((block) => [`${block.heading} (line ${block.line})`, block] as const))('load: %s', (_name, block) => {
    expect(() => parseMapping(block.text, 'neburyx.yaml')).not.toThrow();
  });

  it.each(invalidBlocks.map((block) => [`${block.heading} (line ${block.line})`, block] as const))('are refused with the message the guide quotes: %s', (_name, block) => {
    let message = '';
    try {
      parseMapping(block.text, 'neburyx.yaml');
    } catch (error) {
      expect(error).toBeInstanceOf(MappingError);
      message = error instanceof Error ? (error.message.split('\n')[1] ?? '').trim() : '';
    }
    expect(message).not.toBe('');
    const quoted = guideBlocks().find((candidate) => candidate.marker === 'message: anchor');
    expect(quoted?.text.trim()).toBe(message);
  });
});

describe('the guide holds no query text', () => {
  it('has no cypher block and no line that starts like a statement', () => {
    expect(guideBlocks().filter((block) => block.info.toLowerCase() === 'cypher')).toEqual([]);
    const offending = guideText().split('\n').map((line, index) => [index + 1, line] as const).filter(([, line]) => /^\s*(MATCH|CREATE|MERGE|CALL|RETURN|SHOW)\b/.test(line));
    expect(offending).toEqual([]);
  });
});

describe('the key tables', () => {
  it.each(TABLES.map(([name, schema]) => [name, schema] as const))('list exactly the keys the product accepts: %s', (name, schema) => {
    const listed = guideTable(`keys: ${name}`).map((row) => unticked(row[0] ?? ''));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(keysOf(schema).sort());
  });

  it('list the object form of a pii entry and its five classes', () => {
    const rows = guideTable('keys: pii');
    expect(rows.map((row) => unticked(row[0] ?? ''))).toEqual(['property', 'class']);
    const classRow = rows[1]?.join(' ') ?? '';
    expect(PII_CLASSES).toHaveLength(5);
    for (const piiClass of PII_CLASSES) {
      expect(classRow).toContain(`\`${piiClass}\``);
      const text = `sources:\n  - id: a\n    uri: "neo4j://graph.example.test"\n    database: neo4j\n    auth: { kind: basic, username_env: U, password_env: P }\n    entities:\n      - { type: t, label: T, stable_id: i, pii: [{ property: p, class: ${piiClass} }] }\n`;
      expect(() => parseMapping(text, 'neburyx.yaml')).not.toThrow();
    }
    const extra = `sources:\n  - id: a\n    uri: "neo4j://graph.example.test"\n    database: neo4j\n    auth: { kind: basic, username_env: U, password_env: P }\n    entities:\n      - { type: t, label: T, stable_id: i, pii: [{ property: p, class: name, other: x }] }\n`;
    expect(() => parseMapping(extra, 'neburyx.yaml')).toThrow(MappingError);
  });

  it('marks required only the keys the product requires', () => {
    for (const [name, schema] of TABLES) {
      const inner = unwrap(schema);
      if (!(inner instanceof z.ZodObject)) throw new Error('not an object');
      const shape = inner.shape as Record<string, z.ZodType>;
      for (const row of guideTable(`keys: ${name}`)) {
        const key = unticked(row[0] ?? '');
        const optional = shape[key]?.safeParse(undefined).success === true;
        expect([name, key, row[1]]).toEqual([name, key, optional ? 'no' : 'yes']);
      }
    }
  });
});

describe('the retention table', () => {
  const KEYS: Readonly<Record<string, keyof typeof RETENTION_DEFAULTS>> = {
    deleted_investigations_days: 'deletedInvestigationsDays',
    exports_days: 'exportsDays',
  };

  it('states the range and the default of each key as the product has them', () => {
    expect(guideText()).toContain('a whole number of days from 1 to 365');
    const rows = guideTable('keys: retention');
    expect(rows.map((row) => unticked(row[0] ?? '')).sort()).toEqual(Object.keys(KEYS).sort());
    for (const row of rows) {
      const key = unticked(row[0] ?? '');
      const field = KEYS[key];
      if (field === undefined) throw new Error(`no retention key ${key}`);
      expect(Number(/The default is (\d+)/.exec(row[2] ?? '')?.[1])).toBe(RETENTION_DEFAULTS[field]);
      for (const days of [1, 365]) expect(retentionSchema.safeParse({ [key]: days }).success).toBe(true);
      for (const days of [0, 366, 1.5]) expect(retentionSchema.safeParse({ [key]: days }).success).toBe(false);
    }
  });
});

describe('the budgets table', () => {
  const CAMEL: Readonly<Record<string, keyof typeof BUDGET_DEFAULTS>> = {
    timeout_ms: 'timeoutMs',
    max_page: 'maxPage',
    default_page: 'defaultPage',
    max_hops: 'maxHops',
    path_results_cap: 'pathResultsCap',
    user_concurrency: 'userConcurrency',
    source_concurrency: 'sourceConcurrency',
    queue_wait_ms: 'queueWaitMs',
    breaker_failures: 'breakerFailures',
    breaker_window_ms: 'breakerWindowMs',
    breaker_cooldown_ms: 'breakerCooldownMs',
    heavy_op_threshold: 'heavyOpThreshold',
    requests_per_minute: 'requestsPerMinute',
  };
  const accepts = (key: string, value: number): boolean => budgetsSchema.safeParse({ [key]: value }).success;
  const rows = guideTable('budgets');

  it('lists every key of the schema', () => {
    expect(rows.map((row) => unticked(row[0] ?? '')).sort()).toEqual(keysOf(budgetsSchema).sort());
  });

  it.each(rows.map((row) => [unticked(row[0] ?? ''), row] as const))('gives the minimum, ceiling and default the code holds: %s', (key, row) => {
    const minimum = Number(row[1]);
    expect(accepts(key, minimum)).toBe(true);
    expect(accepts(key, minimum - 1)).toBe(false);
    if (row[2] === 'no ceiling') {
      expect(accepts(key, 2 ** 40)).toBe(true);
    } else {
      const ceiling = Number(row[2]);
      expect(accepts(key, ceiling)).toBe(true);
      expect(accepts(key, ceiling + 1)).toBe(false);
    }
    const name = CAMEL[key];
    expect(name).toBeDefined();
    expect(Number(row[3])).toBe(name === undefined ? Number.NaN : BUDGET_DEFAULTS[name]);
  });
});

describe('the links in the guide', () => {
  const slug = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
  const anchorsOf = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, '')));
  const links = [...guideText().matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '').filter((target) => !/^[a-z]+:/.test(target));

  it('are there', () => {
    expect(links.length).toBeGreaterThan(5);
  });

  it.each(links.map((target) => [target] as const))('resolve: %s', (target) => {
    const [file = '', anchor] = target.split('#');
    const path = file === '' ? GUIDE_PATH : resolve(dirname(GUIDE_PATH), file);
    expect(existsSync(path)).toBe(true);
    if (anchor !== undefined) expect(anchorsOf(path)).toContain(anchor);
  });

  it('start from the docs folder', () => {
    expect(GUIDE_PATH.startsWith(DOCS_FOLDER)).toBe(true);
  });
});

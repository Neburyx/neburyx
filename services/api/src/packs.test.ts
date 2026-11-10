import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceProfileSchema, sourcesResponseSchema } from '@neburyx/contracts';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { parseMapping } from './mapping/load.js';
import type { SourceModel } from './mapping/model.js';
import { mappingFileSchema, type RawMappingFile, type RawSource } from './mapping/schema.js';
import { start, type StartIo } from './start.js';
import { memoryStoreWith } from './testing/app-store.js';
import { issuesOf } from './testing/mapping.js';
import { makeWebRoot } from './testing/web-root.js';
import { makeExportDirectory } from './testing/export-directory.js';

const PACKS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'domain-packs');
const MAPPING_FILE = 'neburyx.yaml';
const DEMO_FILE = 'demo.yaml';
const CASES_FILE = 'cases.yaml';
const THIS_FILE = fileURLToPath(import.meta.url);

const SHIPPED_ENTITY_TYPES = new Map([
  ['banking-fraud', 6],
  ['insurance-claims', 7],
]);
const COMMON_FEATURES = ['pii', 'titleFromPii', 'filterable', 'stopList', 'bothTemplates', 'presetLabels', 'link'] as const;
const EXTRA_FEATURES = new Map<string, readonly string[]>([
  ['banking-fraud', ['reference', 'evidenceRelationship', 'aggregate', 'icons', 'piiOnLinkedAndTarget', 'connectedPreset']],
  ['insurance-claims', []],
]);

function listPacks(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const packs = listPacks(PACKS_ROOT);
const textOf = (pack: string): string => readFileSync(join(PACKS_ROOT, pack, MAPPING_FILE), 'utf8');
const rawOf = (pack: string): RawMappingFile => mappingFileSchema.parse(parse(textOf(pack)));
const asText = (file: RawMappingFile): string => stringify(file, { aliasDuplicateObjects: false, blockQuote: false });

function onlySource<T>(sources: readonly T[]): T {
  const [source] = sources;
  if (source === undefined) throw new Error('expected one source');
  return source;
}
const modelOf = (pack: string): SourceModel => onlySource(parseMapping(textOf(pack), MAPPING_FILE).sources);
/** Adds a bare name to the `pii` list of an entity of the raw file, the way a person editing the YAML would. */
function markPii(entity: object, property: string): void {
  // the raw file's `pii` list now has a typed output shape, and this adds the bare form a person would write, so the entity is read as the raw list
  const target = entity as { pii?: unknown[] };
  target.pii = [...(target.pii ?? []), property];
}

const sourceOf = (file: RawMappingFile): RawSource => onlySource(file.sources);

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'packs-'));
const running: { close: () => Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

const ENV = { DATABASE_URL: 'postgres://app_user@db.example.test:5432/neburyx' };

let counter = 0;
function fileOfText(text: string): string {
  counter += 1;
  const file = join(folder, `mapping-${counter}.yaml`);
  writeFileSync(file, text);
  return file;
}

async function startFile(path: string, store = memoryStoreWith({})) {
  const errors: string[] = [];
  const openStore = vi.fn(() => store);
  const io: StartIo = { stderr: { write: (text) => errors.push(text) }, logger: pino({ level: 'silent' }), defaultWebRoot: webRoot, defaultExportDirectory: exportDirectory, openStore, tasks: [], portOverride: 0 };
  const result = await start({ ...ENV, NEBURYX_CONFIG: path }, io);
  if (result.exitCode === 0) running.push(result.app);
  return { result, message: errors.join(''), openStore };
}

const startWith = (text: string) => startFile(fileOfText(text));

function hiddenValuesOf(pack: string): string[] {
  const source = modelOf(pack);
  return [
    source.uri,
    new URL(source.uri).hostname,
    source.auth.usernameEnv,
    source.auth.passwordEnv,
    ...source.entities.flatMap((entity) => (entity.link === undefined ? [] : [entity.link.template])),
    ...source.relationships.flatMap((relationship) => (relationship.evidenceLink === undefined ? [] : [relationship.evidenceLink.template])),
  ];
}

function linkedIndex(file: RawMappingFile): number {
  const index = sourceOf(file).entities.findIndex((entity) => entity.link !== undefined);
  if (index < 0) throw new Error('expected an entity with a link template');
  return index;
}

describe('the demo case of a pack', () => {
  const presetOf = (pack: string): { readonly entity: { readonly type: string; readonly id: string }; readonly case_ref: string } =>
    z.object({ preset: z.object({ entity: z.object({ type: z.string(), id: z.string() }), case_ref: z.string() }) }).parse(parse(readFileSync(join(PACKS_ROOT, pack, CASES_FILE), 'utf8'))).preset;

  it.each([...SHIPPED_ENTITY_TYPES.keys()])('holds no demo case in the mapping of %s, so its source shows none', (pack) => {
    expect(textOf(pack)).not.toContain('demo_case');
    expect(modelOf(pack).demoCase).toBeUndefined();
  });

  it.each([...SHIPPED_ENTITY_TYPES.keys()])('accepts the preset of the cases file of %s as the demo case of its mapping, and the source then carries it', (pack) => {
    const raw = rawOf(pack);
    const preset = presetOf(pack);
    const withCase = asText({ sources: [{ ...sourceOf(raw), demo_case: preset }] });
    expect(onlySource(parseMapping(withCase, MAPPING_FILE).sources).demoCase).toEqual({ entityType: preset.entity.type, stableId: preset.entity.id, caseRef: preset.case_ref });
  });
});

describe('finding the packs', () => {
  it('lists every directory of the packs folder, each with a mapping file, and includes the shipped packs', () => {
    for (const name of SHIPPED_ENTITY_TYPES.keys()) expect(packs).toContain(name);
    for (const pack of packs) expect(readdirSync(join(PACKS_ROOT, pack))).toContain(MAPPING_FILE);
  });

  it('finds a new pack directory with no change to the code', () => {
    const root = mkdtempSync(join(folder, 'discovery-'));
    mkdirSync(join(root, 'one'));
    mkdirSync(join(root, 'two'));
    writeFileSync(join(root, 'README.md'), 'not a pack');
    expect(listPacks(root)).toEqual(['one', 'two']);
  });
});

describe.each(packs)('the %s pack: the mapping file', (pack) => {
  it('holds the mapping file and a README, and a demo definition and demo cases when the pack has them, and nothing else', () => {
    expect(readdirSync(join(PACKS_ROOT, pack)).filter((name) => name !== DEMO_FILE && name !== CASES_FILE).sort()).toEqual(['README.md', MAPPING_FILE]);
  });

  it('loads with one synthetic source, the entity types the architecture gives and a case reference label', () => {
    expect(parseMapping(textOf(pack), MAPPING_FILE).sources).toHaveLength(1);
    const source = modelOf(pack);
    expect(source.synthetic).toBe(true);
    expect(source.vocabulary.caseRef).toBeTruthy();
    const expected = SHIPPED_ENTITY_TYPES.get(pack);
    if (expected !== undefined) expect(source.entities).toHaveLength(expected);
  });

  it('shows the mapping features the pack is built to show', () => {
    const source = modelOf(pack);
    const shared = source.presets.filter((preset) => preset.template === 'shared-attribute');
    const linked = source.presets.filter((preset) => preset.template === 'linked-entities');
    const linkedTarget = linked[0]?.bind['target'];
    const present = new Map<string, boolean>([
      ['pii', source.entities.some((entity) => entity.pii.length > 0)],
      ['titleFromPii', source.entities.some((entity) => entity.titleUsesPii)],
      ['filterable', source.entities.some((entity) => entity.filterable.length > 0)],
      ['reference', source.entities.some((entity) => entity.reference.length > 0)],
      ['link', source.entities.some((entity) => entity.link !== undefined)],
      ['icons', source.entities.every((entity) => entity.display.icon !== 'generic')],
      ['stopList', source.derived.some((rule) => rule.stopListProperty !== undefined)],
      [
        'evidenceRelationship',
        source.relationships.some(
          (relationship) =>
            relationship.stableId !== undefined && relationship.observedAt !== undefined && relationship.evidence.length > 0 && relationship.evidenceLink !== undefined,
        ),
      ],
      ['aggregate', source.relationships.some((relationship) => relationship.aggregate)],
      ['bothTemplates', shared.length > 0 && linked.length > 0],
      ['presetLabels', source.presets.length > 0 && source.presets.every((preset) => preset.labels['anchor'] !== undefined)],
      [
        'piiOnLinkedAndTarget',
        source.entities.some((entity) => entity.type === linkedTarget && entity.pii.length > 0) &&
          source.entities.some((entity) => entity.type !== linkedTarget && entity.link !== undefined && entity.pii.length > 0),
      ],
      ['connectedPreset', shared.length >= 2 && linkedTarget !== undefined && [...shared, ...linked].every((preset) => preset.bind['anchor'] === linkedTarget)],
    ]);
    for (const feature of [...COMMON_FEATURES, ...(EXTRA_FEATURES.get(pack) ?? [])]) {
      expect(present.get(feature), feature).toBe(true);
    }
  });

  it('names the source address as a host on the demo network and the credentials as variable names', () => {
    const raw = onlySource(rawOf(pack).sources);
    const url = new URL(raw.uri);
    expect(url.hostname).not.toContain('.');
    expect(url.username + url.password).toBe('');
    expect(Object.keys(raw.auth).sort()).toEqual(['kind', 'password_env', 'username_env']);
    const source = modelOf(pack);
    expect(source.auth.usernameEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(source.auth.passwordEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('is refused when a credential value stands where a variable name belongs', async () => {
    const value = 'a credential value 0123';
    const outcome = await startWith(textOf(pack).replace(modelOf(pack).auth.passwordEnv, value));
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.message).toContain('sources[0].auth.password_env');
    expect(outcome.message).toContain('has an invalid format');
    expect(outcome.message).not.toContain(value);
    expect(outcome.openStore).not.toHaveBeenCalled();
  });

  it('holds only plain-text files: no code, no binary, no folder', () => {
    for (const entry of readdirSync(join(PACKS_ROOT, pack), { withFileTypes: true })) {
      expect(entry.isFile(), entry.name).toBe(true);
      expect(['.yaml', '.md']).toContain(extname(entry.name));
    }
  });
});

describe('the packs side by side', () => {
  it('give each pack its own case reference label', () => {
    const labels = packs.map((pack) => modelOf(pack).vocabulary.caseRef);
    expect(new Set(labels).size).toBe(packs.length);
  });

  it('give each pack its own source id', () => {
    expect(new Set(packs.map((pack) => modelOf(pack).id)).size).toBe(packs.length);
  });
});

describe.each(packs)('the %s pack: through start-up and the API', (pack) => {
  async function started() {
    const store = memoryStoreWith({});
    const sync = vi.spyOn(store, 'syncSources');
    const outcome = await startFile(join(PACKS_ROOT, pack, MAPPING_FILE), store);
    if (outcome.result.exitCode !== 0) throw new Error(outcome.message);
    return { app: outcome.result.app, sync };
  }

  it('starts, hands its one source to the store and lists it with the counts of the model', async () => {
    const { app, sync } = await started();
    const source = modelOf(pack);
    expect(sync.mock.calls[0]?.[0].map((candidate) => candidate.id)).toEqual([source.id]);
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(response.statusCode).toBe(200);
    const body = sourcesResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: source.id,
      synthetic: true,
      mappingSummary: { entityTypes: source.entities.length, relationshipTypes: source.relationships.length, derivedRules: source.derived.length },
    });
  });

  it('serves a profile with the types, rules and presets of the model, and nothing secret', async () => {
    const { app } = await started();
    const source = modelOf(pack);
    const response = await app.inject({ method: 'GET', url: `/v1/sources/${source.id}/profile` });
    expect(response.statusCode).toBe(200);
    const profile = sourceProfileSchema.parse(response.json());
    expect(profile.entityTypes.map((entity) => entity.type)).toEqual(source.entities.map((entity) => entity.type));
    expect(profile.relationshipTypes.map((relationship) => relationship.type)).toEqual(source.relationships.map((relationship) => relationship.type));
    expect(profile.derivedRules.map((rule) => rule.id)).toEqual(source.derived.map((rule) => rule.id));
    expect(profile.presets.map((preset) => [preset.id, preset.template])).toEqual(source.presets.map((preset) => [preset.id, preset.template]));
    for (const value of hiddenValuesOf(pack)) expect(response.body).not.toContain(value);
  });

  it('serves an excerpt that wraps back into a source with the same types, and a hash that holds on a second load', async () => {
    const { app } = await started();
    const source = modelOf(pack);
    const response = await app.inject({ method: 'GET', url: `/v1/sources/${source.id}/profile` });
    const profile = sourceProfileSchema.parse(response.json());
    const excerpt = z.record(z.string(), z.unknown()).parse(parse(profile.mappingExcerpt));
    const wrapped = stringify(
      { sources: [{ id: source.id, uri: 'bolt://graph.example.test:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'U', password_env: 'P' }, ...excerpt }] },
      { aliasDuplicateObjects: false, blockQuote: false },
    );
    const reloaded = onlySource(parseMapping(wrapped, 'excerpt.yaml').sources);
    expect(reloaded.entities.map((entity) => entity.type)).toEqual(source.entities.map((entity) => entity.type));
    expect(reloaded.relationships.map((relationship) => relationship.type)).toEqual(source.relationships.map((relationship) => relationship.type));
    expect(reloaded.derived.map((rule) => rule.id)).toEqual(source.derived.map((rule) => rule.id));
    expect(reloaded.presets.map((preset) => preset.id)).toEqual(source.presets.map((preset) => preset.id));
    expect(modelOf(pack).configHash).toBe(source.configHash);
  });
});

interface Mistake {
  readonly name: string;
  readonly mutate: (file: RawMappingFile) => void;
  readonly path: (file: RawMappingFile) => string;
  readonly reason: string;
}

const mistakes: readonly Mistake[] = [
  {
    name: 'an entity without its label',
    mutate: (file) => void Reflect.deleteProperty(sourceOf(file).entities[0] ?? {}, 'label'),
    path: () => 'sources[0].entities[0].label',
    reason: 'is required',
  },
  {
    name: 'a link template with the wrong scheme',
    mutate: (file) => {
      const entity = sourceOf(file).entities[linkedIndex(file)];
      if (entity?.link !== undefined) entity.link = entity.link.replace('https:', 'http:');
    },
    path: (file) => `sources[0].entities[${linkedIndex(file)}].link`,
    reason: 'has a scheme that is not https',
  },
  {
    name: 'a link template with a placeholder in the host',
    mutate: (file) => {
      const entity = sourceOf(file).entities[linkedIndex(file)];
      if (entity !== undefined) entity.link = `https://{${entity.stable_id}}.example.test/x`;
    },
    path: (file) => `sources[0].entities[${linkedIndex(file)}].link`,
    reason: 'has a placeholder in the scheme or host',
  },
  {
    name: 'a link template whose placeholder is marked pii',
    mutate: (file) => {
      const entity = sourceOf(file).entities[linkedIndex(file)];
      if (entity !== undefined) markPii(entity, entity.stable_id);
    },
    path: (file) => `sources[0].entities[${linkedIndex(file)}].link`,
    reason: 'which is marked pii',
  },
  {
    name: 'a duplicate entity type',
    mutate: (file) => {
      const [first] = sourceOf(file).entities;
      if (first !== undefined) sourceOf(file).entities.push(structuredClone(first));
    },
    path: (file) => `sources[0].entities[${sourceOf(file).entities.length - 1}].type`,
    reason: 'repeats entity type',
  },
  {
    name: 'a relationship endpoint that is not a mapped type',
    mutate: (file) => {
      const relationship = sourceOf(file).relationships?.[0];
      if (relationship !== undefined) relationship.to = 'a type nobody mapped';
    },
    path: () => 'sources[0].relationships[0].to',
    reason: 'which is not an entity type of this source',
  },
  {
    name: 'an unknown key',
    mutate: (file) => void Reflect.set(sourceOf(file), 'not_a_key', 'a value'),
    path: () => 'sources[0].not_a_key',
    reason: 'is not a known key',
  },
];

describe.each(packs)('the %s pack: mistakes are refused at start-up', (pack) => {
  it('refuses text that is not valid YAML, naming the line and column and repeating no address, credential or link value', async () => {
    const outcome = await startWith(`${textOf(pack)}\n    broken: [unclosed\n`);
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.message).toContain('is not valid YAML');
    expect(outcome.message).toMatch(/line \d+, column \d+/);
    expect(outcome.openStore).not.toHaveBeenCalled();
    for (const value of hiddenValuesOf(pack)) expect(outcome.message).not.toContain(value);
  });

  it.each(mistakes)('refuses $name: it names the problem and its place and repeats no address, credential or link value', async ({ mutate, path, reason }) => {
    const file = rawOf(pack);
    mutate(file);
    const outcome = await startWith(asText(file));
    expect(outcome.result.exitCode).toBe(1);
    expect('app' in outcome.result).toBe(false);
    expect(outcome.message).toContain(path(file));
    expect(outcome.message).toContain(reason);
    expect(outcome.message).toMatch(/line \d+/);
    expect(outcome.openStore).not.toHaveBeenCalled();
    const mutatedLinks = file.sources.flatMap((source) => [
      ...source.entities.flatMap((entity) => (entity.link === undefined ? [] : [entity.link])),
      ...(source.relationships ?? []).flatMap((relationship) => (relationship.evidence_link === undefined ? [] : [relationship.evidence_link])),
    ]);
    for (const value of [...hiddenValuesOf(pack), ...mutatedLinks, 'a value']) expect(outcome.message).not.toContain(value);
  });

  it('loads a copy cut down to the required keys, with the defaults of the mapping', async () => {
    const source = sourceOf(rawOf(pack));
    const cut: RawMappingFile = {
      sources: [
        {
          id: source.id,
          uri: source.uri,
          database: source.database,
          auth: source.auth,
          entities: source.entities.map((entity) => ({ type: entity.type, label: entity.label, stable_id: entity.stable_id })),
        },
      ],
    };
    const text = asText(cut);
    const loaded = onlySource(parseMapping(text, MAPPING_FILE).sources);
    expect(loaded.entities).toHaveLength(source.entities.length);
    for (const entity of loaded.entities) {
      expect(entity.display.icon).toBe('generic');
      expect(entity.title).toBe(`{${entity.stableId}}`);
      expect(entity.display.keyProperties).toEqual([entity.stableId]);
    }
    const outcome = await startWith(text);
    expect(outcome.result.exitCode).toBe(0);
  });
});

describe('this suite names nothing from a pack', () => {
  it('holds no entity type, label, relationship type or property key of a pack as a string literal', () => {
    const own = readFileSync(THIS_FILE, 'utf8');
    const names = new Set<string>();
    const nameKeys = new Set(['type', 'label', 'stable_id', 'from', 'to', 'title', 'observed_at', 'stop_list_property', 'state_property']);
    const listKeys = new Set(['search', 'pii', 'filterable', 'reference', 'evidence', 'key_properties']);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        for (const [key, member] of Object.entries(value)) {
          if (nameKeys.has(key) && typeof member === 'string') names.add(member);
          if (listKeys.has(key) && Array.isArray(member)) member.forEach((item) => names.add(String(item)));
          walk(member);
        }
      }
    };
    for (const pack of packs) {
      const source = onlySource(rawOf(pack).sources);
      walk([source.entities, source.relationships, source.derived]);
    }
    const literals = [...names].filter((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && new RegExp(`(['"\`])${name}\\1`).test(own));
    expect(literals).toEqual([]);
  });
});

describe('the loader on a pack with a connection address that carries credentials', () => {
  it.each(packs)('refuses the %s pack and carries a path, never the value', (pack) => {
    const file = rawOf(pack);
    sourceOf(file).uri = 'bolt://reader:swordfish@host.example.test';
    const issues = issuesOf(asText(file));
    expect(issues.some((issue) => issue.path === 'sources[0].uri' && issue.reason.includes('carries credentials; use auth'))).toBe(true);
    expect(JSON.stringify(issues)).not.toContain('swordfish');
  });
});

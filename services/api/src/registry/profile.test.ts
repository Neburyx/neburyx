import { rmSync } from 'node:fs';
import { sourceProfileSchema } from '@neburyx/contracts';
import { parse } from 'yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import type { AppStore } from '../app-store.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { MappingModel } from '../mapping/model.js';
import { baseSource, fileOf, type Json } from '../testing/mapping.js';
import { memoryStoreWith } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const fullEntities: Json[] = [
  {
    type: 'node_a',
    label: 'NodeA',
    stable_id: 'id',
    title: 'Item {name}',
    search: ['name', 'code'],
    reference: ['ref'],
    pii: ['name'],
    filterable: ['status'],
    link: 'https://records.example.test/PRIVATE_LINK_PATH/{id}',
    display: { icon: 'document', key_properties: ['status', 'size'], state_property: 'status' },
  },
  { type: 'node_b', label: 'NodeB', stable_id: 'key' },
];
const fullRelationships: Json[] = [
  { type: 'EVENT', from: 'node_a', to: 'node_b', stable_id: 'entryId', observed_at: 'seenAt', evidence: ['recordId'], filterable: ['kind'], evidence_link: 'https://audit.example.test/PRIVATE_EVIDENCE_PATH/{recordId}' },
  { type: 'LINKS', from: 'node_b', to: 'node_a' },
];
const fullDerived: Json[] = [{ id: 'shared', from: 'node_a', to: 'node_a', via: ['EVENT', 'node_b', 'LINKS'], rule_version: 2, stop_list_property: 'isIgnored' }];
const fullPatterns: Json[] = [{ id: 'p', name: 'Shared things', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'EVENT' }, labels: { anchor: 'Starting item', limit: 'Max items' } }];

function fullSource(id = 'demo', overrides: Json = {}): Json {
  return baseSource({
    id,
    uri: 'neo4j+s://PRIVATE-HOST.example.test:7687',
    database: 'private-database',
    auth: { kind: 'basic', username_env: 'PRIVATE_USER_VAR', password_env: 'PRIVATE_PASSWORD_VAR' },
    budgets: { max_page: 33 },
    vocabulary: { case_ref: 'Referral' },
    synthetic: true,
    entities: fullEntities,
    relationships: fullRelationships,
    derived: fullDerived,
    patterns: fullPatterns,
    style_rules: [{ id: 'PRIVATE_STYLE' }],
    ...overrides,
  });
}

function mappingOf(...sources: Json[]): MappingModel {
  return parseMapping(fileOf(...sources), 'neburyx.yaml');
}

async function appFor(mapping: MappingModel, store: AppStore = memoryStoreWith({})): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping });
}

const PRIVATE = ['PRIVATE-HOST', 'private-database', 'PRIVATE_USER_VAR', 'PRIVATE_PASSWORD_VAR', 'PRIVATE_LINK_PATH', 'PRIVATE_EVIDENCE_PATH', 'PRIVATE_STYLE', 'records.example.test', 'audit.example.test', 'max_page', 'maxPage'];

async function profileOf(app: Awaited<ReturnType<typeof appFor>>, id = 'demo'): Promise<{ body: ReturnType<typeof sourceProfileSchema.parse>; text: string; etag: string }> {
  const response = await app.inject({ method: 'GET', url: `/v1/sources/${id}/profile` });
  expect(response.statusCode).toBe(200);
  return { body: sourceProfileSchema.parse(response.json()), text: response.body, etag: String(response.headers['etag']) };
}

describe('the profile of a configured source', () => {
  it('holds the source id, the synthetic flag, the vocabulary and the types in the order of the mapping', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    expect(body).toMatchObject({ sourceId: 'demo', synthetic: true, vocabulary: { caseRef: 'Referral' } });
    expect(body.entityTypes.map((entity) => entity.type)).toEqual(['node_a', 'node_b']);
    expect(body.relationshipTypes.map((relationship) => relationship.type)).toEqual(['EVENT', 'LINKS']);
  });

  it('describes an entity type with every display field, and marks a title built from a pii property', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    expect(body.entityTypes[0]).toEqual({
      type: 'node_a',
      label: 'NodeA',
      icon: 'document',
      title: 'Item {name}',
      titleUsesPii: true,
      keyProperties: ['status', 'size'],
      stateProperty: 'status',
      searchable: ['name', 'code'],
      filterable: ['status'],
      pii: ['name'],
    });
  });

  it('describes an entity type that omits display and title with the defaults of the mapping', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    expect(body.entityTypes[1]).toEqual({
      type: 'node_b',
      label: 'NodeB',
      icon: 'generic',
      title: '{key}',
      titleUsesPii: false,
      keyProperties: ['key'],
      stateProperty: null,
      searchable: [],
      filterable: [],
      pii: [],
    });
  });

  it('marks a relationship type with a stable id as stored and one without as aggregate', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    expect(body.relationshipTypes).toEqual([
      { type: 'EVENT', from: 'node_a', to: 'node_b', aggregate: false, observedAt: 'seenAt', filterable: ['kind'], evidence: ['recordId'] },
      { type: 'LINKS', from: 'node_b', to: 'node_a', aggregate: true, observedAt: null, filterable: [], evidence: [] },
    ]);
  });

  it('holds the derived rules and the pattern presets', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    expect(body.derivedRules).toEqual([{ id: 'shared', from: 'node_a', to: 'node_a', via: ['EVENT', 'node_b', 'LINKS'], ruleVersion: 2 }]);
    expect(body.presets).toEqual([
      {
        id: 'p',
        name: 'Shared things',
        template: 'shared-attribute',
        bind: { anchor: 'node_a', attribute: 'node_b', via: 'EVENT' },
        labels: [{ key: 'anchor', text: 'Starting item' }, { key: 'limit', text: 'Max items' }],
      },
    ]);
  });

  it('gives the same bytes and the same tag when preset label and bind keys are written in another order', async () => {
    const reordered = fullSource('demo', { patterns: [{ ...fullPatterns[0], bind: { via: 'EVENT', attribute: 'node_b', anchor: 'node_a' }, labels: { limit: 'Max items', anchor: 'Starting item' } }] });
    const first = await profileOf(await appFor(mappingOf(fullSource())));
    const second = await profileOf(await appFor(mappingOf(reordered)));
    expect(second.text).toBe(first.text);
    expect(second.etag).toBe(first.etag);
  });

  it('holds a null case reference label when the vocabulary is omitted', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource('demo', { vocabulary: undefined }))));
    expect(body.vocabulary).toEqual({ caseRef: null });
  });

  it('never holds the address, the database, the credential names, the budgets, the link templates or the style rules', async () => {
    const { text } = await profileOf(await appFor(mappingOf(fullSource())));
    for (const secret of PRIVATE) expect(text).not.toContain(secret);
  });

  it('holds only the types of the source asked for', async () => {
    const other = fullSource('other', { entities: [{ type: 'only_other', label: 'Other', stable_id: 'id' }], relationships: [], derived: [], patterns: [] });
    const app = await appFor(mappingOf(fullSource(), other));
    expect((await profileOf(app, 'demo')).text).not.toContain('only_other');
    expect((await profileOf(app, 'other')).body.entityTypes.map((entity) => entity.type)).toEqual(['only_other']);
  });

  it('answers without reading the store, so it works while the database is down', async () => {
    const store = memoryStoreWith({});
    const tripped = vi.fn(() => Promise.reject(new Error('the store must not be called')));
    const guarded: AppStore = { ...store, listSources: tripped, current: tripped, syncSources: tripped, readiness: tripped };
    const app = await appFor(mappingOf(fullSource()), guarded);
    expect((await profileOf(app)).body.sourceId).toBe('demo');
    expect(tripped).not.toHaveBeenCalled();
  });

  it('declares the principal permission', async () => {
    const app = await appFor(mappingOf(fullSource()));
    const route = registeredRoutesOf(app).find((candidate) => candidate.url === '/v1/sources/:id/profile' && candidate.method === 'GET');
    expect(route?.permission).toBe('principal');
  });
});

describe('cache validation', () => {
  async function request(app: Awaited<ReturnType<typeof appFor>>, tag?: string, id = 'demo') {
    return app.inject({ method: 'GET', url: `/v1/sources/${id}/profile`, ...(tag === undefined ? {} : { headers: { 'if-none-match': tag } }) });
  }

  it('carries a strong tag that is the quoted mapping hash and stays the same on a second read', async () => {
    const mapping = mappingOf(fullSource());
    const app = await appFor(mapping);
    const first = await profileOf(app);
    expect(first.etag).toBe(`"${mapping.sources[0]?.configHash}"`);
    expect(first.etag).not.toMatch(/^W\//);
    expect((await profileOf(app)).etag).toBe(first.etag);
  });

  it('answers 304 with no body and the same tag when the tag matches', async () => {
    const app = await appFor(mappingOf(fullSource()));
    const { etag } = await profileOf(app);
    const response = await request(app, etag);
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(response.headers['etag']).toBe(etag);
    expect(response.headers['x-trace-id']).toBeDefined();
  });

  it('answers 304 for a list that holds the tag, for its weak form and for *', async () => {
    const app = await appFor(mappingOf(fullSource()));
    const { etag } = await profileOf(app);
    for (const header of [`"other", ${etag}`, `W/${etag}`, '*', ` ${etag} , "x"`]) {
      expect((await request(app, header)).statusCode, header).toBe(304);
    }
  });

  it('answers 200 for a header that is malformed anywhere, even when it also holds the current tag', async () => {
    const app = await appFor(mappingOf(fullSource()));
    const { etag } = await profileOf(app);
    for (const header of [`"bad tag", ${etag}`, `"bad\ttag", ${etag}`, `"bad\u007ftag", ${etag}`, `garbage, ${etag}`, `${etag}, garbage`, `"unterminated, ${etag}`, `${etag} "x"`, `* , ${etag}`, `${etag},,${etag}`.replace(',,', ',;,')]) {
      expect((await request(app, header)).statusCode, header).toBe(200);
    }
  });

  it('answers 304 for a header that holds a quoted tag with a comma inside, followed by the current tag', async () => {
    const app = await appFor(mappingOf(fullSource()));
    const { etag } = await profileOf(app);
    expect((await request(app, `"a,b", ${etag}`)).statusCode).toBe(304);
  });

  it('answers 200 with the body for another tag, an empty value and text that is not a tag', async () => {
    const app = await appFor(mappingOf(fullSource()));
    for (const header of ['"another"', '', 'not a tag', 'W/"another"', ',']) {
      const response = await request(app, header);
      expect(response.statusCode, header).toBe(200);
      expect(response.json().sourceId).toBe('demo');
    }
  });

  it.each([
    ['a mapped property', { entities: [{ ...fullEntities[0], search: ['name', 'code', 'extra'] }, fullEntities[1]] }],
    ['a display setting', { entities: [{ ...fullEntities[0], display: { icon: 'shield', key_properties: ['status', 'size'], state_property: 'status' } }, fullEntities[1]] }],
    ['a pattern preset', { patterns: [{ ...fullPatterns[0], name: 'Renamed' }] }],
  ])('answers 200 with a new tag for the old tag after a change to %s', async (_name, change) => {
    const before = await profileOf(await appFor(mappingOf(fullSource())));
    const app = await appFor(mappingOf(fullSource('demo', change)));
    const response = await request(app, before.etag);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).not.toBe(before.etag);
  });

  it('keeps answering 304 when another source in the file changes', async () => {
    const before = await profileOf(await appFor(mappingOf(fullSource(), fullSource('other'))));
    const app = await appFor(mappingOf(fullSource(), fullSource('other', { synthetic: false })));
    expect((await request(app, before.etag)).statusCode).toBe(304);
  });
});

describe('the mapping excerpt', () => {
  it('lists entities, relationships, derived rules and patterns under the mapping key names', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    const document = parse(body.mappingExcerpt);
    expect(Object.keys(document)).toEqual(['entities', 'relationships', 'derived', 'patterns']);
  });

  it('loads through the mapping loader inside a source wrapper and equals the original model without link templates', async () => {
    const mapping = mappingOf(fullSource());
    const { body } = await profileOf(await appFor(mapping));
    const excerpt = parse(body.mappingExcerpt);
    const wrapped = fileOf({ id: 'demo', uri: 'neo4j+s://graph.example.test:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'U', password_env: 'P' }, ...excerpt });
    const loaded = parseMapping(wrapped, 'excerpt.yaml').sources[0];
    const original = mapping.sources[0];
    const withoutLinks = original?.entities.map(({ link: _link, ...rest }) => rest);
    const relationshipsWithoutLinks = original?.relationships.map(({ evidenceLink: _evidenceLink, ...rest }) => rest);
    expect(loaded?.entities.map(({ link: _link, ...rest }) => rest)).toEqual(withoutLinks);
    expect(loaded?.relationships).toEqual(relationshipsWithoutLinks);
    expect(loaded?.derived).toEqual(original?.derived);
    expect(loaded?.presets).toEqual(original?.presets);
  });

  it('holds none of the private text', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    for (const secret of PRIVATE) expect(body.mappingExcerpt).not.toContain(secret);
  });

  it('keeps titles and labels with special characters unchanged through the YAML parser', async () => {
    const title = 'Item: {id} # not a comment "quoted" \'single\' \\ back\nsecond line';
    const entity = { type: 'node_a', label: 'Label: with # hash', stable_id: 'id', title };
    const source = fullSource('demo', {
      entities: [entity, fullEntities[1]],
      relationships: [{ type: 'EVENT', from: 'node_a', to: 'node_b' }],
      derived: [],
      patterns: [{ ...fullPatterns[0], name: 'Name: "x" # y', labels: { anchor: 'Start: here # now', limit: "it's" } }],
    });
    const mapping = mappingOf(source);
    const { body } = await profileOf(await appFor(mapping));
    const excerpt = parse(body.mappingExcerpt);
    expect(excerpt.entities[0]).toMatchObject({ title, label: 'Label: with # hash' });
    expect(excerpt.patterns[0]).toMatchObject({ name: 'Name: "x" # y', labels: { anchor: 'Start: here # now', limit: "it's" } });
    const loaded = parseMapping(fileOf({ id: 'demo', uri: 'neo4j+s://graph.example.test:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'U', password_env: 'P' }, ...excerpt }), 'x');
    expect(loaded.sources[0]?.entities[0]?.title).toBe(title);
  });

  it('stays inside the accepted YAML subset, with no block scalar, tag, anchor or alias', async () => {
    const entity = { type: 'node_a', label: 'A', stable_id: 'id', title: 'line one\nline two {id}' };
    const { body } = await profileOf(await appFor(mappingOf(fullSource('demo', { entities: [entity, fullEntities[1]], relationships: [], derived: [], patterns: [] }))));
    expect(body.mappingExcerpt).not.toMatch(/: [|>]/);
    expect(body.mappingExcerpt).not.toMatch(/(^|\s)[&*!][A-Za-z]/);
  });

  it('leaves out every value the loader fills in by default, so the excerpt stays small', async () => {
    const { body } = await profileOf(await appFor(mappingOf(fullSource())));
    const document = parse(body.mappingExcerpt);
    expect(document.entities[1]).toEqual({ type: 'node_b', label: 'NodeB', stable_id: 'key' });
    expect(document.relationships[1]).toEqual({ type: 'LINKS', from: 'node_b', to: 'node_a' });
  });

  it('is byte-identical for the same mapping and changes with the mapped types', async () => {
    const first = (await profileOf(await appFor(mappingOf(fullSource())))).body.mappingExcerpt;
    const second = (await profileOf(await appFor(mappingOf(fullSource())))).body.mappingExcerpt;
    const changed = (await profileOf(await appFor(mappingOf(fullSource('demo', { entities: [fullEntities[0], fullEntities[1], { type: 'node_c', label: 'C', stable_id: 'id' }] }))))).body.mappingExcerpt;
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('reloads when the whole excerpt is wrapped back into a source for a mapping of minimal flow-style entities near the file size limit', async () => {
    const header = ['sources:', '  - id: demo', '    uri: neo4j+s://graph.example.test:7687', '    database: neo4j', '    auth: {kind: basic, username_env: U, password_env: P}'];
    const lines: string[] = [];
    let size = header.join('\n').length + '    entities:'.length;
    for (let index = 0; size < 1024 * 1024 - 400; index++) {
      const line = `      - {type: t${index}, label: L${index}, stable_id: id}`;
      lines.push(line);
      size += line.length + 1;
    }
    const original = `${[...header, '    entities:', ...lines].join('\n')}\n`;
    expect(Buffer.byteLength(original)).toBeLessThanOrEqual(1024 * 1024);
    const mapping = parseMapping(original, 'big.yaml');
    const { body } = await profileOf(await appFor(mapping));
    const wrapped = `${[...header, ...body.mappingExcerpt.trimEnd().split('\n').map((line) => `    ${line}`)].join('\n')}\n`;
    expect(Buffer.byteLength(wrapped)).toBeLessThanOrEqual(1024 * 1024);
    const loaded = parseMapping(wrapped, 'wrapped.yaml').sources[0];
    expect(loaded?.entities).toHaveLength(lines.length);
    expect(loaded?.relationships).toEqual([]);
  }, 60_000);

  it('is complete and valid for a mapping close to the file size limit', async () => {
    const many = Array.from({ length: 4000 }, (_unused, index) => ({ type: `type_${index}`, label: `Label ${index}`, stable_id: 'id', search: ['a'.repeat(120)] }));
    const text = fileOf(fullSource('demo', { entities: many, relationships: [], derived: [], patterns: [] }));
    expect(Buffer.byteLength(text)).toBeGreaterThan(700_000);
    expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
    const mapping = parseMapping(text, 'big.yaml');
    const { body } = await profileOf(await appFor(mapping));
    expect(parse(body.mappingExcerpt).entities).toHaveLength(4000);
    expect(body.entityTypes).toHaveLength(4000);
    const wrapped = fileOf({ id: 'demo', uri: 'neo4j+s://graph.example.test:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'U', password_env: 'P' }, ...parse(body.mappingExcerpt) });
    expect(Buffer.byteLength(wrapped)).toBeLessThan(1024 * 1024);
    expect(parseMapping(wrapped, 'wrapped.yaml').sources[0]?.entities).toHaveLength(4000);
  }, 60_000);
});

describe('unknown and malformed requests', () => {
  async function get(app: Awaited<ReturnType<typeof appFor>>, url: string, method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' = 'GET') {
    return app.inject({ method, url });
  }

  it('answers 404 NOT_FOUND with the trace id for an id no source has', async () => {
    const response = await get(await appFor(mappingOf(fullSource())), '/v1/sources/nope/profile');
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'NOT_FOUND', traceId: response.headers['x-trace-id'] });
  });

  it('answers 404 for a source that is no longer in the mapping', async () => {
    const app = await appFor(mappingOf(fullSource('kept')));
    expect((await get(app, '/v1/sources/removed/profile')).statusCode).toBe(404);
  });

  it.each([
    ['a very long id', `/v1/sources/${'a'.repeat(5000)}/profile`],
    ['an encoded slash', '/v1/sources/a%2Fb/profile'],
    ['a dot segment', '/v1/sources/./profile'],
    ['two dots', '/v1/sources/../profile'],
    ['constructor', '/v1/sources/constructor/profile'],
    ['__proto__', '/v1/sources/__proto__/profile'],
    ['toString', '/v1/sources/toString/profile'],
    ['an empty id', '/v1/sources//profile'],
  ])('answers 404 for an unconfigured id that is %s, never 500 and never a profile', async (_name, url) => {
    const response = await get(await appFor(mappingOf(fullSource())), url);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('answers 200 for configured sources named constructor and toString and for an encoded configured id', async () => {
    const app = await appFor(mappingOf(fullSource('constructor'), fullSource('toString'), fullSource('a-b')));
    expect((await get(app, '/v1/sources/constructor/profile')).statusCode).toBe(200);
    expect((await get(app, '/v1/sources/toString/profile')).statusCode).toBe(200);
    const encoded = await get(app, '/v1/sources/a%2Db/profile');
    expect(encoded.statusCode).toBe(200);
    expect(encoded.json().sourceId).toBe('a-b');
  });

  it('answers 400 INVALID_REQUEST with the trace id for an invalid percent escape', async () => {
    const response = await get(await appFor(mappingOf(fullSource())), '/v1/sources/%ZZ/profile');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST', traceId: response.headers['x-trace-id'] });
  });

  it.each(['?limit=1', '?x=1', '?cursor='])('answers 400 INVALID_REQUEST for the query %s', async (query) => {
    const response = await get(await appFor(mappingOf(fullSource())), `/v1/sources/demo/profile${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('answers 404 NOT_FOUND with the trace header, and no body for HEAD, to HEAD and to other methods', async () => {
    const app = await appFor(mappingOf(fullSource()));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const head = await fetch(`http://127.0.0.1:${port}/v1/sources/demo/profile`, { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
    expect(head.headers.get('x-trace-id')).not.toBeNull();
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await get(app, '/v1/sources/demo/profile', method);
      expect(response.statusCode, method).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
      expect(response.headers['x-trace-id']).toBeDefined();
    }
    await app.close();
  });
});

describe('the profile and the excerpt of a source whose pii fields have classes', () => {
  const classed = fullSource('demo', {
    entities: [{ type: 'node_a', label: 'NodeA', stable_id: 'id', title: 'Item {code}', search: ['code'], pii: ['plain', { property: 'phone', class: 'phone' }, { property: 'name', class: 'name' }] }],
    relationships: [],
    derived: [],
    patterns: [],
  });

  it('lists the names of the pii fields, bare and classed alike, and nothing of the classes', async () => {
    const { body, text } = await profileOf(await appFor(mappingOf(classed)));
    expect(body.entityTypes[0]?.pii).toEqual(['plain', 'phone', 'name']);
    expect(text).not.toMatch(/"class"|piiClass/);
  });

  it('writes the pii names of the excerpt as bare names, with no class, and the excerpt loads back to the same names', async () => {
    const { body } = await profileOf(await appFor(mappingOf(classed)));
    const excerpt = parse(body.mappingExcerpt) as { entities: { pii?: unknown[] }[] };
    expect(excerpt.entities[0]?.pii).toEqual(['plain', 'phone', 'name']);
    expect(body.mappingExcerpt).not.toMatch(/class/);
  });
});

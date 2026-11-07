import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { normalizeModelOf } from '../gate/normalize/model.js';
import { normalizeRows } from '../gate/normalize/index.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll } from '../testing/neo4j-server.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import { DEGREE_PREVIEW_BOUNDED_ID, degreePreviewBoundedTemplate } from '../gate/templates/degree-preview.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import { schemaIndexesTemplate } from '../gate/templates/schema-indexes.js';
import { isKeyed } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { itemsOf, madeRecordCount, removeMadeRecords, startPackServers, withMadeRecords, type PackServer } from '../testing/normalization-capture.js';
import { PACKS } from '../testing/pack-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { communityAccess } from '../testing/source-access.js';
import { createEntityReader } from './entity-reader.js';

let servers: PackServer[] = [];

beforeAll(async () => {
  servers = await startPackServers();
}, 900_000);

afterAll(async () => {
  await runAll(servers.map((target) => () => target.close()).concat(servers.map((target) => () => target.server.stop())));
});

function readerOf(target: PackServer) {
  const mapping = { sources: [target.source] };
  return createEntityReader({ gate: target.gate, mapping, access: communityAccess(mapping) });
}

async function load(target: PackServer, entityType: string, stableId: string, mask = false) {
  return readerOf(target).read({ traceId: 'tr-entity-load', principal: LOCAL_PRINCIPAL, sourceId: target.source.id, entityType, stableId, mask });
}

function expectedFrom(target: PackServer, row: Record<string, unknown>) {
  const [node] = normalizeRows({ sourceId: target.source.id, hasMore: false, model: normalizeModelOf(target.source) }, [row]).nodes;
  if (node === undefined) throw new Error('the captured record is not a node of the mapping');
  return node;
}

describe.each(PACKS)(`the entity read on the demo graph of the %s pack on ${NEO4J_SERIES}`, (pack) => {
  function target(): PackServer {
    const found = servers.find((candidate) => candidate.pack === pack);
    if (found === undefined) throw new Error('no server');
    return found;
  }

  it('answers, for one entity of every entity type, the node the Normalization suite builds from the same record, with only mapped properties', async () => {
    const { source } = target();
    expect(source.entities.length).toBeGreaterThan(0);
    for (const entity of source.entities) {
      const [row] = await itemsOf(target(), 'capture-node', { entityType: entity.type });
      if (row === undefined) throw new Error(`the demo graph holds no ${entity.type}`);
      const expected = expectedFrom(target(), row);
      const actual = await load(target(), entity.type, expected.ref.stableId);
      expect(actual, entity.type).toEqual(expected);
      const projection = new Set(normalizeModelOf(source).entitiesByType.get(entity.type)?.projection);
      expect(actual.properties.every((property) => projection.has(property.key)), entity.type).toBe(true);
    }
  });

  it('masks each personal-data value the node has, by its class, and a title built from one, and leaks no original value', async () => {
    const { source } = target();
    const marked = source.entities.filter((entity) => entity.pii.length > 0);
    expect(marked.length).toBeGreaterThan(0);
    for (const entity of marked) {
      const [row] = await itemsOf(target(), 'capture-node', { entityType: entity.type });
      if (row === undefined) throw new Error(`the demo graph holds no ${entity.type}`);
      const plain = expectedFrom(target(), row);
      const masked = await load(target(), entity.type, plain.ref.stableId, true);
      for (const key of entity.pii) {
        const before = plain.properties.find((property) => property.key === key);
        const after = masked.properties.find((property) => property.key === key);
        if (before?.value === undefined) {
          expect(after?.value, `${entity.type}.${key}`).toBeUndefined();
          continue;
        }
        expect(after, `${entity.type}.${key}`).toMatchObject({ masked: true, maskedBy: 'request' });
        expect(JSON.stringify(masked), `${entity.type}.${key}`).not.toContain(JSON.stringify(before.value).slice(1, -1));
      }
      const unmarked = masked.properties.filter((property) => !entity.pii.includes(property.key));
      expect(unmarked).toEqual(plain.properties.filter((property) => !entity.pii.includes(property.key)));
    }
  });

  it('leaves a node of a type without personal-data fields unchanged when masking is asked', async () => {
    const { source } = target();
    const clear = source.entities.find((entity) => entity.pii.length === 0);
    if (clear === undefined) return;
    const [row] = await itemsOf(target(), 'capture-node', { entityType: clear.type });
    if (row === undefined) throw new Error(`the demo graph holds no ${clear.type}`);
    const plain = expectedFrom(target(), row);
    expect(await load(target(), clear.type, plain.ref.stableId, true)).toEqual(plain);
  });

  it('answers NOT_FOUND for an ID the graph does not hold', async () => {
    const [entity] = target().source.entities;
    if (entity === undefined) throw new Error('the pack has no entity type');
    const failure = await load(target(), entity.type, 'ZZ-NOT-IN-THE-GRAPH').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('shows a record with a stable ID and none of the key properties as the Normalization suite does, flagged as missing properties', async () => {
    await withMadeRecords(target(), async () => {
      const rows = await itemsOf(target(), 'capture-made', {});
      const row = rows.find((candidate) => JSON.stringify(candidate).includes('ZZ-NORM-3'));
      if (row === undefined) throw new Error('the made record is missing');
      const expected = expectedFrom(target(), row);
      const actual = await load(target(), expected.ref.entityType, 'ZZ-NORM-3');
      expect(actual).toEqual(expected);
      expect(actual.qualityFlags).toContain('missing-property');
    });
  });

  it('removes every record it made, also when a read fails part-way', async () => {
    expect(await madeRecordCount(target())).toBe(0);
    const failure = await withMadeRecords(target(), async () => {
      const [entity] = target().source.entities;
      await load(target(), entity?.type ?? '', 'ZZ-NOT-IN-THE-GRAPH');
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
    expect(await madeRecordCount(target())).toBe(0);
  });
});

describe.each(PACKS)(`the entity read of the %s pack against records written by hand, on ${NEO4J_SERIES}`, (pack) => {
  const FULL_MASK = '••••••';
  const quote = (name: string): string => `\`${name}\``;

  function target(): PackServer {
    const found = servers.find((candidate) => candidate.pack === pack);
    if (found === undefined) throw new Error('no server');
    return found;
  }

  async function withHandWrittenRecords(create: string, checks: () => Promise<void>): Promise<void> {
    await removeMadeRecords(target());
    try {
      await runAdmin(target().server, create);
      await checks();
    } finally {
      await removeMadeRecords(target());
    }
  }

  const property = (node: Awaited<ReturnType<typeof load>>, key: string) => node.properties.find((candidate) => candidate.key === key);

  /** A value of each class of personal data, what the read shows of it, and what the read shows when masking is asked. The values are written here, not taken from the code under test. */
  const SAMPLES = {
    name: { cypher: "'Ana Maria Silva'", shown: 'Ana Maria Silva', shownClass: 'text', masked: 'A••• M••• S•••', maskedClass: 'name' },
    email: { cypher: "'ana.silva@example.test'", shown: 'ana.silva@example.test', shownClass: 'text', masked: 'a•••@•••', maskedClass: 'email' },
    phone: { cypher: "'+44 7700 900123'", shown: '+44 7700 900123', shownClass: 'text', masked: `+44 ${FULL_MASK}23`, maskedClass: 'phone' },
    date: { cypher: "date('1985-03-09')", shown: '1985-03-09', shownClass: 'date', masked: FULL_MASK, maskedClass: 'date' },
    text: { cypher: "'some private words'", shown: 'some private words', shownClass: 'text', masked: FULL_MASK, maskedClass: 'text' },
  } as const;

  it('masks each personal-data value in the shape of its class, and a title that is that value, and leaks none of the originals', async () => {
    const marked = target().source.entities.filter((entity) => entity.pii.length > 0);
    expect(marked.length).toBeGreaterThan(0);
    const sampleOf = (entity: (typeof marked)[number], key: string) => SAMPLES[entity.piiClasses?.[key] ?? 'text'];
    const statements = marked.map((entity, index) => {
      const values = entity.pii.map((key) => `${quote(key)}: ${sampleOf(entity, key).cypher}`);
      return `(:${quote(entity.label)} {${quote(entity.stableId)}: 'ZZ-ENT-${index}', ${values.join(', ')}, zzMarker: 'e${index}'})`;
    });
    await withHandWrittenRecords(`CREATE ${statements.join(', ')}`, async () => {
      for (const [index, entity] of marked.entries()) {
        const id = `ZZ-ENT-${index}`;
        const plain = await load(target(), entity.type, id);
        const masked = await load(target(), entity.type, id, true);
        for (const key of entity.pii) {
          const sample = sampleOf(entity, key);
          expect(property(plain, key), `${entity.type}.${key}`).toEqual({ key, value: sample.shown, dataClass: sample.shownClass, masked: false });
          expect(property(masked, key), `${entity.type}.${key}`).toEqual({ key, value: sample.masked, dataClass: sample.maskedClass, masked: true, maskedBy: 'request' });
          if (entity.title === `{${key}}`) {
            expect(plain.display.title, entity.type).toBe(sample.shown);
            expect(masked.display.title, entity.type).toBe(sample.masked);
          }
          expect(JSON.stringify(masked), `${entity.type}.${key}`).not.toContain(sample.shown);
        }
      }
    });
  });

  it('shows each kind of date and time as the text the server gives, with its kind', async () => {
    const entity = target().source.entities.find((candidate) => candidate.display.keyProperties.some((key) => key !== candidate.stableId && !candidate.pii.includes(key)));
    const key = entity?.display.keyProperties.find((candidate) => candidate !== entity.stableId && !entity.pii.includes(candidate));
    if (entity === undefined || key === undefined) throw new Error('the pack has no entity type with a key property that is neither the stable ID nor personal data');
    const kinds = [
      { cypher: "date('2026-01-02')", value: '2026-01-02', dataClass: 'date' },
      { cypher: "datetime('2026-01-02T03:04:05.123456789+02:00')", value: '2026-01-02T03:04:05.123456789+02:00', dataClass: 'dateTime' },
      { cypher: "localdatetime('2026-01-02T03:04:05')", value: '2026-01-02T03:04:05', dataClass: 'localDateTime' },
      { cypher: "time('10:11:12Z')", value: '10:11:12Z', dataClass: 'time' },
      { cypher: "localtime('10:11:12')", value: '10:11:12', dataClass: 'localTime' },
      { cypher: "duration('P1Y2M3DT4H5M6S')", value: 'P1Y2M3DT4H5M6S', dataClass: 'duration' },
    ] as const;
    const statements = kinds.map((kind, index) => `(:${quote(entity.label)} {${quote(entity.stableId)}: 'ZZ-TIME-${index}', ${quote(key)}: ${kind.cypher}, zzMarker: 't${index}'})`);
    await withHandWrittenRecords(`CREATE ${statements.join(', ')}`, async () => {
      for (const [index, kind] of kinds.entries()) {
        const node = await load(target(), entity.type, `ZZ-TIME-${index}`);
        expect(property(node, key), kind.dataClass).toEqual({ key, value: kind.value, dataClass: kind.dataClass, masked: false });
      }
    });
  });

  it('falls back to the type and the stable ID for a title whose value is missing, and invents no mask for a personal-data value that is missing', async () => {
    const entity = target().source.entities.find((candidate) => candidate.pii.length > 0 && candidate.titleProperties.some((key) => candidate.pii.includes(key)));
    if (entity === undefined) throw new Error('the pack has no entity type with a title built from personal data');
    await withHandWrittenRecords(`CREATE (:${quote(entity.label)} {${quote(entity.stableId)}: 'ZZ-BARE', zzMarker: 'b1'})`, async () => {
      for (const mask of [false, true]) {
        const node = await load(target(), entity.type, 'ZZ-BARE', mask);
        expect(node.display.title, `mask ${mask}`).toBe(`${entity.type} ZZ-BARE`);
        expect(node.qualityFlags, `mask ${mask}`).toContain('title-incomplete');
        for (const key of entity.pii) {
          const shown = property(node, key);
          expect(shown === undefined || (shown.value === undefined && shown.masked === false), `${entity.type}.${key} mask ${mask}`).toBe(true);
        }
        expect(JSON.stringify(node), `mask ${mask}`).not.toContain(FULL_MASK);
      }
    });
  });
});

/** A gate over the pack's server whose mapping adds a second entity type with the label and the stable ID property of the first one that is not keyed. */
function sharedLabelGate(target: PackServer) {
  const first = target.source.entities.find((entity) => !isKeyed(entity));
  if (first === undefined) throw new Error('the pack has no entity type that is not keyed');
  const twin = { ...first, type: `${first.type}-twin` };
  const source = { ...target.source, entities: [...target.source.entities, twin] };
  const mapping = { sources: [source] };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: { DEMO_NEO4J_USER: target.server.reader.user, DEMO_NEO4J_PASSWORD: target.server.reader.password, ...envFor(target.server) }, logger: { warn: () => undefined } });
  const defaults = communitySeams();
  const { gate } = assembleGate({
    mapping,
    seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit },
    executor,
    logger: { warn: () => undefined },
    catalog: createTemplateCatalog({ templates: [entityLoadTemplate, schemaIndexesTemplate, degreePreviewBoundedTemplate] }),
  });
  const reader = createEntityReader({ gate, mapping, access: communityAccess(mapping) });
  return { first, twin, gate, reader, close: () => executor.close() };
}

describe(`the entity read of an entity type whose label another type shares, on ${NEO4J_SERIES}`, () => {
  it('answers the node as the type it is asked for, for either type, and its degree read counts the node with the label and the ID', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const shared = sharedLabelGate(target);
    try {
      const [row] = await itemsOf(target, 'capture-node', { entityType: shared.first.type });
      if (row === undefined) throw new Error(`the demo graph holds no ${shared.first.type}`);
      const expected = expectedFrom(target, row);
      for (const entityType of [shared.first.type, shared.twin.type]) {
        const node = await shared.reader.read({ traceId: 'tr-shared', principal: LOCAL_PRINCIPAL, sourceId: target.source.id, entityType, stableId: expected.ref.stableId, mask: false });
        expect(node.ref, entityType).toEqual({ sourceId: target.source.id, entityType, stableId: expected.ref.stableId });
        expect(node.properties, entityType).toEqual(expected.properties);
      }
      const hasPairs = target.source.relationships.some((relationship) => relationship.from === shared.first.type || relationship.to === shared.first.type);
      if (hasPairs) {
        const page = await shared.gate.run({ traceId: 'tr-shared-degree', principal: LOCAL_PRINCIPAL, sourceId: target.source.id, templateId: DEGREE_PREVIEW_BOUNDED_ID, params: { entityType: shared.first.type, stableId: expected.ref.stableId }, limit: 1 });
        expect(page.items[0]).toMatchObject({ found: true, duplicate: false });
      }
      const missing = await shared.reader.read({ traceId: 'tr-shared-missing', principal: LOCAL_PRINCIPAL, sourceId: target.source.id, entityType: shared.twin.type, stableId: 'ZZ-NOT-THERE', mask: false }).catch((error: unknown) => error);
      expect(missing).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await shared.close();
    }
  });
});

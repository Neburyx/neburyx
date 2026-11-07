import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nodeSchema, type GraphNode } from '@neburyx/contracts';
import { AppError } from '../../errors.js';
import { fakeClock, gateRequest, harness, rowsOf, SOURCE_A, testCatalog, testTemplate, TestExecutor } from '../../testing/gate.js';
import { redactContext, plainNode } from '../../testing/normalize-fixtures.js';
import { mappingOf, sourceWith } from '../../testing/gate-fixtures.js';
import { fixtureRows, PACKS, packSource } from '../../testing/pack-fixtures.js';
import { firstSource } from '../../testing/mapping.js';
import { normalizeModelOf } from '../normalize/model.js';
import { normalizeRows, type Normalized } from '../normalize/index.js';
import { normalizeExpansion } from '../normalize/expansion.js';
import { maskValue, redactItems, redactResult } from './index.js';

const REQUEST = 'the-request';

/** The element at an index; a test fails here, not later, when there is none. */
function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`no element at ${index}`);
  return found;
}

describe.each(PACKS)('the redact stage on the rows of an expansion of the %s pack', (pack) => {
  const source = packSource(pack);
  const model = normalizeModelOf(source);
  const expansions = (['expansionStored', 'expansionAggregate'] as const).map((name) => {
    const row = source.relationships.find((candidate) => (name === 'expansionStored') === (candidate.stableId !== undefined));
    if (row === undefined) throw new Error('the pack has no such relationship');
    return normalizeExpansion({ sourceId: REQUEST, hasMore: false, model, params: { entityType: row.from, neighborType: row.to } }, fixtureRows(pack, name));
  });

  it('masks every personal-data property of the anchor and the neighbors of a masked request, and gives an aggregate edge no property value', () => {
    let seen = 0;
    for (const page of expansions) {
      const masked = redactResult(page, redactContext(model, true));
      for (const node of masked.nodes) {
        const entity = model.entitiesByType.get(node.ref.entityType);
        for (const property of node.properties) {
          if (entity?.pii.includes(property.key) && property.value !== undefined) {
            expect(property.masked).toBe(true);
            seen += 1;
          }
        }
      }
      for (const edge of masked.edges.filter((candidate) => 'aggregate' in candidate.ref)) expect(edge.properties).toEqual([]);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('changes nothing for a request that does not ask for masking', () => {
    for (const page of expansions) expect(redactResult(page, redactContext(model, false))).toEqual(page);
  });
});

const isNormalizedItem = (item: Record<string, unknown>): item is Record<string, unknown> & Normalized => Array.isArray(item['nodes']) && Array.isArray(item['edges']);

describe.each(PACKS)('the redact stage on the captured nodes of the %s pack', (pack) => {
  const source = packSource(pack);
  const model = normalizeModelOf(source);
  const plain = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, fixtureRows(pack, 'piiNodes'));
  const items = [{ ...plain }];
  const masked = redactResult(plain, redactContext(model, true));

  const piiOf = (node: GraphNode) => model.entitiesByType.get(node.ref.entityType)?.pii ?? [];

  it('has nodes whose entity types mark pii fields', () => {
    expect(plain.nodes.length).toBeGreaterThan(0);
    expect(plain.nodes.some((node) => piiOf(node).some((key) => node.properties.some((property) => property.key === key && property.value !== undefined)))).toBe(true);
  });

  it('masks every pii property when the request asks, as { masked: true, maskedBy: request } with the mask of its class, and leaves the other properties as they were', () => {
    masked.nodes.forEach((node, index) => {
      const before = at(plain.nodes, index);
      const entity = model.entitiesByType.get(node.ref.entityType);
      node.properties.forEach((property, position) => {
        const original = before.properties[position];
        if (entity?.pii.includes(property.key) && original?.value !== undefined) {
          expect(property).toMatchObject({ key: property.key, value: maskValue(original.value, entity.piiClasses[property.key]), masked: true, maskedBy: 'request' });
        } else {
          expect(property).toEqual(original);
        }
      });
    });
  });

  it('masks nothing when the request does not ask: every value equals the normalizer\'s', () => {
    expect(redactItems(items, redactContext(model, false))).toEqual(items);
  });

  it('leaves the original pii values out of the serialized response, for the nodes whose title is not built from a pii field, and has the mask and masked: true in it', () => {
    const safe = masked.nodes.filter((node) => model.entitiesByType.get(node.ref.entityType)?.titleProperties.every((key) => !piiOf(node).includes(key)));
    expect(safe.length).toBeGreaterThan(0);
    for (const node of safe) {
      const before = at(plain.nodes, masked.nodes.indexOf(node));
      const originals = before.properties.filter((property) => piiOf(node).includes(property.key) && property.value !== undefined).map((property) => String(property.value));
      const text = JSON.stringify({ ...masked, nodes: [node] });
      for (const value of originals) expect(text).not.toContain(value);
      if (originals.length > 0) {
        expect(text).toContain('"masked":true');
        expect(text).toContain('•');
      }
    }
  });
});

describe('the redact stage on an item that is not a normalized result', () => {
  it('passes it through, with or without the flag', () => {
    const model = normalizeModelOf(packSource('banking-fraud'));
    const item = { product: 'Neo4j Kernel', version: '5.26.32' };
    expect(redactItems([item], redactContext(model, true))).toEqual([item]);
    expect(redactItems([item], redactContext(model, false))).toEqual([item]);
  });

  it('leaves a pii property the record lacks as it is: no value, nothing invented, not masked', () => {
    const source = packSource('banking-fraud');
    const model = normalizeModelOf(source);
    const entity = source.entities.find((candidate) => candidate.pii.length > 0);
    const [first] = entity?.pii ?? [];
    const node: GraphNode = {
      ref: { sourceId: REQUEST, entityType: entity?.type ?? '', stableId: 'x' },
      display: { title: 'x', type: entity?.type ?? '' },
      properties: [{ key: first ?? '', dataClass: 'unknown', masked: false }],
      qualityFlags: ['missing-property'],
      provenanceRefs: [],
      authorization: { canInspect: true, canExport: true },
    };
    const result = redactResult({ nodes: [node], unreferenced: [], edges: [], dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] }, redactContext(model, true));
    expect(result.nodes[0]?.properties[0]).toEqual({ key: first, dataClass: 'unknown', masked: false });
  });

  it('leaves a node of an entity type the model does not know as it is', () => {
    const model = normalizeModelOf(packSource('banking-fraud'));
    const node: GraphNode = {
      ref: { sourceId: REQUEST, entityType: 'unknown-type', stableId: 'x' },
      display: { title: 'x', type: 'unknown-type' },
      properties: [{ key: 'k', value: 'v', dataClass: 'text', masked: false }],
      qualityFlags: [],
      provenanceRefs: [],
      authorization: { canInspect: true, canExport: true },
    };
    const result = { nodes: [node], unreferenced: [], edges: [], dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
    expect(redactResult(result, redactContext(model, true)).nodes[0]).toEqual(node);
  });
});

describe('the mask flag at the gate', () => {
  const source = packSource('banking-fraud');
  const model = normalizeModelOf(source);
  const [entity] = source.entities.filter((candidate) => candidate.pii.length > 0);
  const node = at(fixtureRows('banking-fraud', 'piiNodes'), 0);

  const dataTemplate = testTemplate({
    id: 'data-read',
    scope: 'user',
    paramsSchema: z.strictObject({}),
    normalize: (rows, _plan, context) => (context === undefined ? [] : [{ ...normalizeRows(context, rows) }]),
  });
  const systemTemplate = testTemplate({ id: 'data-system', scope: 'system', paramsSchema: z.strictObject({}), normalize: dataTemplate.normalize });

  function rig() {
    const clock = fakeClock(1_000_000);
    return harness({ catalog: testCatalog([dataTemplate, systemTemplate]), modelFor: () => model, executor: new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [node] })), clock: clock.now });
  }

  const first = (page: { items: readonly Record<string, unknown>[] }): GraphNode => {
    const item = at(page.items, 0);
    if (!isNormalizedItem(item)) throw new Error('the page holds no normalized result');
    return at(item.nodes, 0);
  };

  it('masks the pii properties of a user read that asks, and no property of one that does not', async () => {
    const { gate } = rig();
    const masked = first(await gate.run(gateRequest({ templateId: 'data-read', params: {}, mask: true })));
    const plain = first(await gate.run(gateRequest({ templateId: 'data-read', params: {} })));
    const asked = first(await gate.run(gateRequest({ templateId: 'data-read', params: {}, mask: false })));
    expect(entity).toBeDefined();
    expect(masked.properties.some((property) => property.masked)).toBe(true);
    expect(plain.properties.every((property) => !property.masked)).toBe(true);
    expect(asked).toEqual(plain);
  });

  it('never masks for the system runner', async () => {
    const { system } = rig();
    const page = await system.run({ traceId: 't', sourceId: SOURCE_A, templateId: 'data-system', params: {}, limit: 5 });
    expect(first(page).properties.every((property) => !property.masked)).toBe(true);
  });

  it('answers an error and returns no items when the redact stage fails', async () => {
    const failing = harness({
      catalog: testCatalog([dataTemplate]),
      modelFor: () => model,
      executor: new TestExecutor(() => Promise.resolve(rowsOf(1))),
      redact: () => {
        throw new Error('the stage failed');
      },
    });
    const outcome = await failing.gate.run(gateRequest({ templateId: 'data-read', params: {}, mask: true })).then(
      () => 'items',
      (error: unknown) => (error instanceof AppError ? error.code : 'not an AppError'),
    );
    expect(outcome).toBe('INTERNAL_ERROR');
  });
});

describe('the masks in the shape of the class a pack gives', () => {
  const SHAPES: Readonly<Record<string, RegExp>> = {
    name: /^\p{L}•••( \p{L}•••)*$/u,
    email: /^\p{L}•••@•••$/u,
    phone: /^\+\d{1,3} ••••••\d\d$/,
    date: /^••••••$/,
    text: /^••••••$/,
  };

  it.each(PACKS)('shows each pii property of the %s pack\'s captured nodes in the shape of its class, and gives it the class as its data class', (pack) => {
    const model = normalizeModelOf(packSource(pack));
    const plain = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, fixtureRows(pack, 'piiNodes'));
    const masked = redactResult(plain, redactContext(model, true)).nodes;
    let classed = 0;
    for (const node of masked) {
      const entity = model.entitiesByType.get(node.ref.entityType);
      for (const property of node.properties.filter((candidate) => candidate.masked)) {
        const piiClass = entity?.piiClasses[property.key];
        expect(piiClass, `${node.ref.entityType}.${property.key} has a class in the pack`).toBeDefined();
        expect(String(property.value)).toMatch(SHAPES[piiClass ?? 'text'] ?? /^••••••$/);
        expect(property.dataClass).toBe(piiClass);
        classed += 1;
      }
    }
    expect(classed).toBeGreaterThan(0);
  });
});

describe('the masks of every class through the gate stage, on a synthetic mapping', () => {
  const mapped = mappingOf(
    sourceWith('alpha', {
      entities: [
        {
          type: 'gadget',
          label: 'Gadget',
          stable_id: 'gadgetId',
          title: 'Gadget {kind}',
          pii: [{ property: 'keeper', class: 'name' }, { property: 'mail', class: 'email' }, { property: 'tel', class: 'phone' }, { property: 'born', class: 'date' }, { property: 'note', class: 'text' }, 'bare', { property: 'badMail', class: 'email' }],
          display: { key_properties: ['kind'] },
        },
      ],
      relationships: [],
    }),
  );
  const model = normalizeModelOf(firstSource(mapped));

  it('masks each field in the shape of its class, a bare field and a field whose value does not fit its class fully, and leaves the other properties', () => {
    const node = plainNode(['Gadget'], { gadgetId: 'g1', kind: 'lamp', keeper: 'Ivo Lowe', mail: 'ivo.lowe@example.test', tel: '+44 20 7946 0958', born: { $type: 'date', value: '1988-10-21' }, note: 'a long free text', bare: 'bare value', badMail: 'not an email' });
    const result = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, [{ n: node }]);
    const masked = at(redactResult(result, redactContext(model, true)).nodes, 0);
    const by = (key: string) => masked.properties.find((property) => property.key === key);
    expect(by('keeper')).toEqual({ key: 'keeper', value: 'I••• L•••', dataClass: 'name', masked: true, maskedBy: 'request' });
    expect(by('mail')).toEqual({ key: 'mail', value: 'i•••@•••', dataClass: 'email', masked: true, maskedBy: 'request' });
    expect(by('tel')).toEqual({ key: 'tel', value: '+44 ••••••58', dataClass: 'phone', masked: true, maskedBy: 'request' });
    expect(by('born')).toEqual({ key: 'born', value: '••••••', dataClass: 'date', masked: true, maskedBy: 'request' });
    expect(by('note')).toEqual({ key: 'note', value: '••••••', dataClass: 'text', masked: true, maskedBy: 'request' });
    expect(by('bare')).toEqual({ key: 'bare', value: '••••••', dataClass: 'text', masked: true, maskedBy: 'request' });
    expect(by('badMail')).toEqual({ key: 'badMail', value: '••••••', dataClass: 'email', masked: true, maskedBy: 'request' });
    expect(by('kind')).toEqual({ key: 'kind', value: 'lamp', dataClass: 'text', masked: false });
    expect(JSON.stringify(masked)).not.toMatch(/Ivo Lowe|ivo\.lowe|7946|1988-10-21|free text|bare value|not an email/);
  });
});

describe.each(PACKS)('the titles built from pii fields in the %s pack', (pack) => {
  const source = packSource(pack);
  const model = normalizeModelOf(source);
  const plain = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, fixtureRows(pack, 'piiNodes'));
  const masked = redactResult(plain, redactContext(model, true));

  it('masks a title built from a pii field, with the mask of that field\'s class, and leaves the title of a node whose title uses no pii field', () => {
    let built = 0;
    masked.nodes.forEach((node, index) => {
      const entity = model.entitiesByType.get(node.ref.entityType);
      const before = at(plain.nodes, index);
      if (entity?.titleProperties.some((key) => entity.pii.includes(key)) === true) {
        const expected = entity.title.replace(/\{([^{}]*)\}/g, (_whole, key: string) => {
          const value = before.properties.find((property) => property.key === key)?.value;
          return entity.pii.includes(key) ? maskValue(value, entity.piiClasses[key]) : String(value);
        });
        expect(node.display.title).toBe(expected);
        expect(node.display.title).not.toBe(before.display.title);
        built += 1;
      } else {
        expect(node.display.title).toBe(before.display.title);
      }
    });
    expect(built).toBeGreaterThan(0);
  });

  it('leaves no original pii value anywhere in the whole serialized response, titles included, and has the masks and masked: true in it', () => {
    const text = JSON.stringify(masked);
    for (const node of plain.nodes) {
      const entity = model.entitiesByType.get(node.ref.entityType);
      for (const property of node.properties) if (entity?.pii.includes(property.key) === true && property.value !== undefined) expect(text).not.toContain(String(property.value));
    }
    expect(text).toContain('"masked":true');
    expect(text).toContain('•');
  });

  it('shows the original title again, with every value, when the request does not ask', () => {
    const unmasked = redactResult(plain, redactContext(model, false));
    expect(unmasked.nodes.map((node) => node.display.title)).toEqual(plain.nodes.map((node) => node.display.title));
  });
});

describe('the title of a node on a synthetic mapping', () => {
  const mapped = mappingOf(
    sourceWith('alpha', {
      entities: [
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', title: 'Gadget {kind} of {keeper}', pii: [{ property: 'keeper', class: 'name' }, 'secret'], display: { key_properties: ['kind'] } },
        { type: 'plain', label: 'Plain', stable_id: 'plainId', title: 'Plain {kind}', pii: ['secret'] },
        { type: 'bare', label: 'Bare', stable_id: 'bareId', title: '{secret}', pii: ['secret'] },
      ],
      relationships: [],
    }),
  );
  const model = normalizeModelOf(firstSource(mapped));
  const masked = (node: ReturnType<typeof plainNode>) => {
    const result = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, [{ n: node }]);
    return at(redactResult(result, redactContext(model, true)).nodes, 0);
  };

  it('fills a placeholder of a pii field with its mask and the others with their values', () => {
    expect(masked(plainNode(['Gadget'], { gadgetId: 'g1', kind: 'lamp', keeper: 'Ivo Lowe' })).display.title).toBe('Gadget lamp of I••• L•••');
  });

  it('uses the full mask for a pii field with no class', () => {
    expect(masked(plainNode(['Bare'], { bareId: 'b1', secret: 'hush hush' })).display.title).toBe('••••••');
  });

  it('keeps a title with no pii placeholder as it is, though the entity has other pii fields', () => {
    expect(masked(plainNode(['Plain'], { plainId: 'p1', kind: 'wide', secret: 'hush' })).display.title).toBe('Plain wide');
  });

  it('keeps the fallback title, which holds no pii value, when a placeholder value is missing', () => {
    const node = masked(plainNode(['Gadget'], { gadgetId: 'g2', kind: 'lamp' }));
    expect(node.display.title).toBe('gadget g2');
    expect(node.qualityFlags).toContain('title-incomplete');
  });
});

describe('values that are not text, and fields named like members of every object', () => {
  const mapped = mappingOf(
    sourceWith('alpha', {
      entities: [
        {
          type: 'gadget',
          label: 'Gadget',
          stable_id: 'gadgetId',
          title: '{serial} {born} {constructor}',
          pii: [{ property: 'serial', class: 'name' }, { property: 'born', class: 'date' }, 'constructor', 'toString', { property: '__proto__', class: 'text' }, { property: 'valueOf', class: 'phone' }],
          display: { key_properties: ['gadgetId'] },
        },
      ],
      relationships: [],
    }),
  );
  const model = normalizeModelOf(firstSource(mapped));
  const node = plainNode(['Gadget'], { gadgetId: 'g1', serial: { $type: 'integer', value: '9223372036854775807' }, born: { $type: 'dateTime', value: '2026-01-02T03:04:05+02:00' }, constructor: 'Ivo Lowe', toString: 'hidden text', ['__proto__']: 'kept as data', valueOf: '+1-555-8945' });
  const result = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, [{ n: node }]);
  const masked = redactResult(result, redactContext(model, true));
  const property = (key: string) => at(masked.nodes, 0).properties.find((candidate) => candidate.key === key);

  it('masks a tagged integer, a temporal value and any other value that is not text fully, whatever the class', () => {
    expect(property('serial')).toMatchObject({ value: '••••••', dataClass: 'name', masked: true });
    expect(property('born')).toMatchObject({ value: '••••••', dataClass: 'date', masked: true });
    expect(JSON.stringify(masked)).not.toContain('9223372036854775807');
    expect(JSON.stringify(masked)).not.toContain('2026-01-02');
  });

  it('masks the title with the full mask for those values as well', () => {
    expect(at(masked.nodes, 0).display.title).toBe('•••••• •••••• ••••••');
    expect(at(masked.nodes, 0).display.title).not.toContain('9•••');
  });

  it('gives a field with no class of its own the kind of its value, though its name is that of a member of every object', () => {
    expect(property('constructor')).toMatchObject({ value: '••••••', dataClass: 'text', masked: true });
    expect(property('toString')).toMatchObject({ value: '••••••', dataClass: 'text', masked: true });
    expect(typeof property('constructor')?.dataClass).toBe('string');
  });

  it('keeps a class the mapping gives to a field named like a member of every object', () => {
    expect(property('valueOf')).toMatchObject({ value: '+1 ••••••45', dataClass: 'phone', masked: true });
  });

  it('gives a node that is valid for the contract', () => {
    for (const node of masked.nodes) expect(nodeSchema.safeParse(node).success).toBe(true);
  });
});


describe('the unreferenced hits of a result', () => {
  const source = firstSource(
    mappingOf(
      sourceWith('alpha', {
        entities: [{ type: 'holder', label: 'Holder', stable_id: 'email', title: '{ownerLabel} ({email})', search: ['nickname'], pii: [{ property: 'email', class: 'email' }, { property: 'ownerLabel', class: 'name' }] }],
        relationships: [],
      }),
    ),
  );
  const model = normalizeModelOf(source);
  const plain = normalizeRows({ sourceId: REQUEST, hasMore: false, model }, [{ n: plainNode(['Holder'], { email: 4.5, ownerLabel: 'Ana Silva', nickname: 'needle' }) }]);

  it('are masked as nodes are when the request asks: each personal-data property and the title built from one', () => {
    const [hit] = redactResult(plain, redactContext(model, true)).unreferenced;
    expect(hit?.properties.find((property) => property.key === 'ownerLabel')).toMatchObject({ masked: true, maskedBy: 'request', dataClass: 'name' });
    // the unusable stable ID of a keyed type is the personal data itself, so it is masked too
    expect(hit?.properties.find((property) => property.key === 'email')).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(JSON.stringify(hit)).not.toContain('Ana Silva');
    expect(JSON.stringify(hit)).not.toContain('4.5');
    expect(hit?.properties.find((property) => property.key === 'nickname')).toMatchObject({ value: 'needle', masked: false });
  });

  it('are left as they are when the request does not ask', () => {
    expect(redactResult(plain, redactContext(model, false)).unreferenced).toEqual(plain.unreferenced);
    expect(plain.unreferenced[0]?.title).toBe('Ana Silva (4.5)');
  });
});

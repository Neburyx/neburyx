import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AuditEvent, AuditSink } from '../seams/seams.js';
import { createCursorCodec } from './cursor/codec.js';
import { fakeClock, gateRequest, harness, LOCAL_PRINCIPAL, rowsOf, SOURCE_A, SOURCE_B, TEST_CURSOR_KEY, TEST_REFERENCE_KEYS, testCatalog, testTemplate, TestExecutor, type HarnessOptions } from '../testing/gate.js';
import { createTemplateCatalog } from './catalog.js';
import { filterHashOf } from './cursor/binding.js';
import type { Row, Template } from './types.js';
import { SYSTEM_PRINCIPAL } from './system-principal.js';

const CYPHER = 'MATCH (n:Item) WHERE n.key = $key AND ($cursor IS NULL OR n.title > $cursor.title) RETURN n.title AS title ORDER BY n.title LIMIT $limit + 1';

function pagedTemplate(overrides: Partial<Template> = {}): Template {
  return testTemplate({
    id: 'paged-read',
    version: '1',
    cypher: CYPHER,
    paged: true,
    sort: 'title:asc',
    nextPosition: (rows: readonly Row[]) => {
      const last = rows.at(-1);
      return last === undefined ? undefined : { title: String(last['title']) };
    },
    ...overrides,
  });
}

function rig(options: HarnessOptions = {}, template: Template = pagedTemplate()) {
  const clock = fakeClock(1_000_000);
  const audit: AuditEvent[] = [];
  const sink: AuditSink = { record: (event) => Promise.resolve(void audit.push(event)) };
  const executor = new TestExecutor((call) => Promise.resolve(rowsOf(call.rowLimit)));
  const parts = harness({ catalog: testCatalog([template, testTemplate()]), executor, clock: clock.now, seams: { audit: sink }, ...options });
  return { ...parts, clock, audit };
}

const request = (overrides: Parameters<typeof gateRequest>[0] = {}) => gateRequest({ templateId: 'paged-read', limit: 2, ...overrides });
const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

describe('a paged read through the gate', () => {
  it('returns a signed cursor for the next page when the read found more than the page, in the form v1.<payload>.<mac>', async () => {
    const { gate } = rig();
    const page = await gate.run(request());
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });

  it('returns no cursor when there is no more, when the template says no position, and for a template that is not paged', async () => {
    const none = rig({ executor: new TestExecutor(() => Promise.resolve(rowsOf(1))) });
    expect('nextCursor' in (await none.gate.run(request()))).toBe(false);
    const noPosition = rig({}, pagedTemplate({ nextPosition: () => undefined }));
    expect('nextCursor' in (await noPosition.gate.run(request()))).toBe(false);
    const plain = rig();
    expect(await plain.gate.run(gateRequest({ limit: 2 }))).toEqual({ items: [{ title: 'item 1' }, { title: 'item 2' }], hasMore: true });
  });

  it('gives the template the verified position as the parameter cursor on the next request, and null on the first', async () => {
    const { gate, executor } = rig();
    const first = await gate.run(request());
    expect(executor.calls[0]?.parameters['cursor']).toBeNull();
    await gate.run(request({ cursor: first.nextCursor }));
    expect(executor.calls[1]?.parameters['cursor']).toEqual({ title: 'item 2' });
    expect(executor.calls[1]?.parameters['limit']).toBe(2);
  });

  it('refuses a cursor with one changed character as CURSOR_INVALIDATED, without reading the source', async () => {
    const { gate, executor } = rig();
    const first = await gate.run(request());
    const cursor = first.nextCursor ?? '';
    const changed = cursor.slice(0, -2) + (cursor.at(-2) === 'A' ? 'B' : 'A') + cursor.slice(-1);
    expect(await code(gate.run(request({ cursor: changed })))).toBe('CURSOR_INVALIDATED');
    expect(executor.calls).toHaveLength(1);
  });

  it('refuses a cursor on a template that is not paged as INVALID_REQUEST, without reading the source', async () => {
    const { gate, executor } = rig();
    const first = await gate.run(request());
    expect(await code(gate.run(gateRequest({ cursor: first.nextCursor })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toHaveLength(1);
  });

  it('refuses a cursor once it has expired, and accepts it one millisecond before', async () => {
    const { gate, clock } = rig();
    const first = await gate.run(request());
    clock.advance(30 * 60_000 - 1);
    await gate.run(request({ cursor: first.nextCursor }));
    clock.advance(1);
    expect(await code(gate.run(request({ cursor: first.nextCursor })))).toBe('CURSOR_INVALIDATED');
  });

  it('refuses a request that carries cursor among its parameters, and a template that declares one', async () => {
    const { gate } = rig();
    expect(await code(gate.run(request({ params: { key: 'k1', cursor: { title: 'x' } } })))).toBe('INVALID_REQUEST');
    const declared = pagedTemplate({ paramsSchema: z.strictObject({ key: z.string(), cursor: z.string() }) });
    expect(() => createTemplateCatalog({ templates: [{ ...declared, paged: true }] })).toThrowError('declares the reserved parameter cursor');
  });

  it('fails with INTERNAL_ERROR, and shows nothing of the position, when the template gives a position the cursor cannot hold', async () => {
    const { gate } = rig({}, pagedTemplate({ nextPosition: () => ({ title: { nested: 'POSITION-SECRET' } as never }) }));
    const error: unknown = await gate.run(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify([error, String(error)])).not.toContain('POSITION-SECRET');
  });
});

describe('a cursor is bound to its request', () => {
  /** A cursor from the first page of the read, used for a second request that changes only what the test says. */
  async function nextPageWith(next: Parameters<typeof gateRequest>[0]) {
    const parts = rig();
    const page = await parts.gate.run(request());
    const calls = parts.executor.calls.length;
    const result = await code(parts.gate.run(request({ ...next, cursor: page.nextCursor })));
    return { result, read: parts.executor.calls.length > calls, audit: parts.audit };
  }

  it('accepts a smaller limit', async () => {
    expect((await nextPageWith({ limit: 1 })).result).toBe('none');
  });

  it('refuses another source, and does not read it', async () => {
    const result = await nextPageWith({ sourceId: SOURCE_B });
    expect(result).toMatchObject({ result: 'CURSOR_INVALIDATED', read: false });
  });

  it('refuses another principal', async () => {
    expect((await nextPageWith({ principal: { ...LOCAL_PRINCIPAL, id: 'someone-else' } })).result).toBe('CURSOR_INVALIDATED');
  });

  it('refuses another policy version', async () => {
    const first = rig({ policyVersion: () => 'one' });
    const page = await first.gate.run(request());
    const changed = rig({ policyVersion: () => 'two', cursors: createCursorCodec({ key: TEST_CURSOR_KEY, clock: first.clock.now }) });
    expect(await code(changed.gate.run(request({ cursor: page.nextCursor })))).toBe('CURSOR_INVALIDATED');
    const same = rig({ policyVersion: () => 'one', cursors: createCursorCodec({ key: TEST_CURSOR_KEY, clock: first.clock.now }) });
    expect(await code(same.gate.run(request({ cursor: page.nextCursor })))).toBe('none');
  });

  it('refuses a changed parameter, and accepts the same parameters whatever the order of their keys', async () => {
    expect((await nextPageWith({ params: { key: 'k2' } })).result).toBe('CURSOR_INVALIDATED');
    const object = pagedTemplate({ paramsSchema: z.strictObject({ key: z.string(), window: z.strictObject({ from: z.string(), to: z.string() }) }) });
    const first = rig({}, object);
    const page = await first.gate.run(request({ params: { key: 'k', window: { from: 'a', to: 'b' } } }));
    expect(await code(first.gate.run(request({ params: { key: 'k', window: { to: 'b', from: 'a' } }, cursor: page.nextCursor })))).toBe('none');
    expect(await code(first.gate.run(request({ params: { key: 'k', window: { from: 'a', to: 'c' } }, cursor: page.nextCursor })))).toBe('CURSOR_INVALIDATED');
  });

  it('binds the keyed HMAC of the canonical validated parameters, taken before limit and cursor are added', async () => {
    const { gate, executor } = rig();
    const page = await gate.run(request());
    const payload = JSON.parse(Buffer.from((page.nextCursor ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { f: string };
    expect(payload.f).toBe(filterHashOf({ key: 'k1' }, TEST_REFERENCE_KEYS.filterHash));
    expect(executor.calls[0]?.parameters).toMatchObject({ limit: 2 });
  });

  it('refuses another template and another template version', async () => {
    const base = rig();
    const page = await base.gate.run(request());
    const bumped = rig({ cursors: createCursorCodec({ key: TEST_CURSOR_KEY, clock: base.clock.now }) }, pagedTemplate({ version: '2' }));
    expect(await code(bumped.gate.run(request({ cursor: page.nextCursor })))).toBe('CURSOR_INVALIDATED');
    const renamed = rig({ cursors: createCursorCodec({ key: TEST_CURSOR_KEY, clock: base.clock.now }) }, pagedTemplate({ id: 'paged-other' }));
    expect(await code(renamed.gate.run(request({ templateId: 'paged-other', cursor: page.nextCursor })))).toBe('CURSOR_INVALIDATED');
  });

  it('refuses another sort', async () => {
    const base = rig();
    const page = await base.gate.run(request());
    const resorted = rig({ cursors: createCursorCodec({ key: TEST_CURSOR_KEY, clock: base.clock.now }) }, pagedTemplate({ sort: 'title:desc' }));
    expect(await code(resorted.gate.run(request({ cursor: page.nextCursor })))).toBe('CURSOR_INVALIDATED');
  });

  it('records the refusal as refused, and says nothing about which field differed', async () => {
    const { result, audit } = await nextPageWith({ sourceId: SOURCE_B });
    expect(result).toBe('CURSOR_INVALIDATED');
    expect(audit.at(-1)).toMatchObject({ result: 'refused', sourceId: SOURCE_B });
    const { gate } = rig();
    const page = await gate.run(request());
    const error: unknown = await gate.run(request({ sourceId: SOURCE_B, cursor: page.nextCursor })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CURSOR_INVALIDATED', details: undefined });
  });

  it('is bound to the system principal that minted it: a user principal cannot use it, and the system runner has no cursor to give', async () => {
    const { gate, system } = rig({}, pagedTemplate({ scope: 'system' }));
    const viaSystem = await system.run({ traceId: 't', sourceId: SOURCE_A, templateId: 'paged-read', params: { key: 'k1' }, limit: 2 });
    expect(viaSystem.nextCursor).toBeDefined();
    expect(await code(gate.run(request({ cursor: viaSystem.nextCursor })))).toBe('CURSOR_INVALIDATED');
    expect(SYSTEM_PRINCIPAL.id).not.toBe(LOCAL_PRINCIPAL.id);
  });
});

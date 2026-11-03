import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import type { AuditEvent } from '../../seams/seams.js';
import { gateRequest, harness, rowsOf, testCatalog, testTemplate, TestExecutor } from '../../testing/gate.js';
import { createCursorCodec, type CursorBinding } from './codec.js';

const MARKER = 'MARKER-KEY-0123456789-ABCDEFGHIJ';
const KEY = Buffer.from(MARKER, 'utf8');
const SECRET_POSITION = 'POSITION-VALUE-8841';
const binding: CursorBinding = { source: 'alpha', principal: 'user-1', policyVersion: 'none', filterHash: 'f'.repeat(64), sort: '', target: 'expand', targetVersion: '1' };
const KEY_FORMS = [MARKER, KEY.toString('base64'), KEY.toString('base64url'), KEY.toString('hex')];

const everythingAbout = (error: unknown): string => JSON.stringify([error, String(error), (error as Error).message, (error as Error).stack, Object.getOwnPropertyNames(error as object)]);

/** The error a call throws; the test fails if it does not throw, so a leak check can never pass without a failure. */
function thrown(run: () => unknown): AppError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  return caught as AppError;
}

describe('what a cursor failure shows', () => {
  const codec = createCursorCodec({ key: KEY, clock: () => 1_000 });
  const cursor = codec.mint(binding, { at: SECRET_POSITION });

  it.each([
    ['one character added', `${cursor}x`],
    ['empty', ''],
    ['a wrong MAC', cursor.replace(/\.[^.]+$/, '.AAAA')],
    ['another principal', codec.mint({ ...binding, principal: 'other' }, { at: SECRET_POSITION })],
  ])('holds neither the key nor the cursor nor a position value, for a verification failure: %s', (_name, bad) => {
    const error = thrown(() => codec.verify(bad, binding));
    expect(error.code).toBe('CURSOR_INVALIDATED');
    const text = everythingAbout(error);
    for (const secret of [...KEY_FORMS, SECRET_POSITION, ...(bad === '' ? [] : [bad])]) expect(text).not.toContain(secret);
  });

  it('holds neither the key nor a position value for a minting failure', () => {
    const error = thrown(() => codec.mint(binding, { at: SECRET_POSITION, nested: { deeper: SECRET_POSITION } } as never));
    expect(error.code).toBe('INTERNAL_ERROR');
    const text = everythingAbout(error);
    for (const secret of [...KEY_FORMS, SECRET_POSITION]) expect(text).not.toContain(secret);
  });

  it('does not put the key in a cursor it mints', () => {
    for (const secret of KEY_FORMS) expect(cursor).not.toContain(secret);
    expect(Buffer.from(cursor.split('.')[1] ?? '', 'base64url').toString('utf8')).not.toContain(MARKER);
  });
});

describe('what the gate shows when a cursor fails', () => {
  const paged = testTemplate({
    id: 'paged-read',
    paged: true,
    nextPosition: () => ({ at: SECRET_POSITION }),
  });
  const badPosition = testTemplate({ id: 'paged-bad', paged: true, nextPosition: () => ({ at: { nested: SECRET_POSITION } } as never) });

  function rig() {
    const audit: AuditEvent[] = [];
    const parts = harness({
      catalog: testCatalog([paged, badPosition]),
      cursors: createCursorCodec({ key: KEY, clock: () => 1_000_000 }),
      executor: new TestExecutor((call) => Promise.resolve(rowsOf(call.rowLimit))),
      seams: { audit: { record: (event) => Promise.resolve(void audit.push(event)) } },
    });
    return { ...parts, audit };
  }

  it('leaves the key, the cursor and the position in no log line, audit event or error of a verification failure', async () => {
    const { gate, logs, audit } = rig();
    const page = await gate.run(gateRequest({ templateId: 'paged-read', limit: 2 }));
    const cursor = page.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const tampered = `${cursor}x`;
    const error: unknown = await gate.run(gateRequest({ templateId: 'paged-read', limit: 2, cursor: tampered })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('CURSOR_INVALIDATED');
    expect(audit.at(-1)).toMatchObject({ result: 'refused' });
    const text = JSON.stringify([logs, audit, everythingAbout(error)]);
    for (const secret of [...KEY_FORMS, SECRET_POSITION, tampered, cursor]) expect(text).not.toContain(secret);
  });

  it('leaves the key and the position in no log line, audit event or error of a minting failure', async () => {
    const { gate, logs, audit } = rig();
    const error: unknown = await gate.run(gateRequest({ templateId: 'paged-bad', limit: 2 })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL_ERROR');
    expect(audit.at(-1)).toMatchObject({ result: 'failed' });
    const text = JSON.stringify([logs, audit, everythingAbout(error)]);
    for (const secret of [...KEY_FORMS, SECRET_POSITION]) expect(text).not.toContain(secret);
  });
});

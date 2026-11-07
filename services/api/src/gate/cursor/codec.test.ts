import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../testing/gate.js';
import { canonicalJson, filterHashOf } from './binding.js';
import { CURSOR_TTL_MS, createCursorCodec, type CursorBinding } from './codec.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const START = 1_000_000;
const binding: CursorBinding = { source: 'alpha', principal: 'user-1', policyVersion: 'none', filterHash: 'f'.repeat(64), sort: 'seen:desc', target: 'expand', targetVersion: '3' };
const position = { seen: '2026-01-02T03:04:05Z', id: 'r-9', n: 4, nothing: null, flag: true };

function rig(key: Uint8Array = KEY) {
  const clock = fakeClock(START);
  return { clock, codec: createCursorCodec({ key, clock: clock.now }) };
}

const invalidated = (run: () => unknown): void => {
  expect(run).toThrowError(expect.objectContaining({ code: 'CURSOR_INVALIDATED' }));
};

describe('a cursor', () => {
  it('round trips: the position that was minted comes back for the same binding', () => {
    const { codec } = rig();
    expect(codec.verify(codec.mint(binding, position), binding)).toEqual(position);
  });

  it('is the text v1.<payload>.<mac>, base64url, signed with HMAC-SHA256 over v1.<payload>', () => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    const [version, payload, mac] = cursor.split('.');
    expect(version).toBe('v1');
    expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toMatchObject({ s: 'alpha', p: 'user-1', pv: 'none', o: 'seen:desc', t: 'expand', tv: '3', d: position });
    expect(mac).toBe(createHashHmac(`v1.${payload}`));
  });

  it('expires 30 minutes after it is minted, the boundary included, and verifies one millisecond before', () => {
    const { codec, clock } = rig();
    const cursor = codec.mint(binding, position);
    expect(CURSOR_TTL_MS).toBe(30 * 60 * 1000);
    clock.advance(CURSOR_TTL_MS - 1);
    expect(codec.verify(cursor, binding)).toEqual(position);
    clock.advance(1);
    invalidated(() => codec.verify(cursor, binding));
    clock.advance(10_000);
    invalidated(() => codec.verify(cursor, binding));
  });

  it('is judged against the clock of the verifier, and only its expiry is checked', () => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    const behind = createCursorCodec({ key: KEY, clock: () => START - 5_000 });
    expect(behind.verify(cursor, binding)).toEqual(position);
  });
});

describe('a cursor is bound to its request', () => {
  const changes: readonly (readonly [string, Partial<CursorBinding>])[] = [
    ['source', { source: 'beta' }],
    ['no source', { source: null }],
    ['principal', { principal: 'user-2' }],
    ['policy version', { policyVersion: '2' }],
    ['filter hash', { filterHash: 'e'.repeat(64) }],
    ['sort', { sort: 'seen:asc' }],
    ['target', { target: 'search' }],
    ['target version', { targetVersion: '4' }],
  ];

  it.each(changes)('is refused for another %s', (_name, change) => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    invalidated(() => codec.verify(cursor, { ...binding, ...change }));
  });

  it('is used for a list route: the target is the route, and a cursor for one route is refused for another', () => {
    const { codec } = rig();
    const route: CursorBinding = { ...binding, source: null, target: 'GET /v1/investigations', targetVersion: '1' };
    expect(codec.verify(codec.mint(route, position), route)).toEqual(position);
    invalidated(() => codec.verify(codec.mint(route, position), { ...route, target: 'GET /v1/audit' }));
  });
});

describe('a cursor that was changed, re-spelled or forged', () => {
  it('is refused when any one character is changed, at every position', () => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let refused = 0;
    for (let index = 0; index < cursor.length; index += 1) {
      const original = cursor[index] ?? '';
      const replacement = original === '.' ? 'A' : alphabet[(alphabet.indexOf(original) + 1) % alphabet.length] ?? 'A';
      const changed = cursor.slice(0, index) + replacement + cursor.slice(index + 1);
      try {
        codec.verify(changed, binding);
      } catch (error) {
        if ((error as { code?: string }).code === 'CURSOR_INVALIDATED') refused += 1;
      }
    }
    expect(refused).toBe(cursor.length);
  });

  it.each([
    ['one character removed', (c: string) => c.slice(0, -1)],
    ['one character added', (c: string) => `${c}A`],
    ['a character removed from the payload', (c: string) => c.slice(0, 5) + c.slice(6)],
    ['empty', () => ''],
    ['one part', () => 'v1'],
    ['two parts', (c: string) => c.split('.').slice(0, 2).join('.')],
    ['four parts', (c: string) => `${c}.x`],
    ['another version', (c: string) => c.replace(/^v1/, 'v2')],
    ['no version', (c: string) => c.replace(/^v1\./, '')],
  ])('is refused when %s', (_name, change) => {
    const { codec } = rig();
    invalidated(() => codec.verify(change(codec.mint(binding, position)), binding));
  });

  it.each([[undefined], [null], [42], [{}], [['v1', 'a', 'b']]])('is refused when it is not text: %j', (value) => {
    const { codec } = rig();
    invalidated(() => codec.verify(value, binding));
  });

  it('is refused when its payload was decoded, changed and re-encoded and the original MAC was kept', () => {
    const { codec } = rig();
    const [version, payload, mac] = codec.mint(binding, position).split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...decoded, e: Number(decoded['e']) + 3_600_000 }), 'utf8').toString('base64url');
    invalidated(() => codec.verify(`${version}.${forged}.${mac}`, binding));
  });

  it('is refused when it was signed with another key', () => {
    const { codec } = rig();
    const { codec: other } = rig(OTHER_KEY);
    invalidated(() => codec.verify(other.mint(binding, position), binding));
  });

  it.each([
    ['an extra field', (p: Record<string, unknown>) => ({ ...p, x: 1 })],
    ['a missing field', (p: Record<string, unknown>) => ({ ...p, tv: undefined })],
    ['a wrong type', (p: Record<string, unknown>) => ({ ...p, e: '9999999999999' })],
    ['an expiry that is not an integer', (p: Record<string, unknown>) => ({ ...p, e: 9_999_999_999_999.5 })],
    ['a nested position', (p: Record<string, unknown>) => ({ ...p, d: { a: { b: 1 } } })],
    ['a list position', (p: Record<string, unknown>) => ({ ...p, d: [1, 2] })],
    ['a position value that is a list', (p: Record<string, unknown>) => ({ ...p, d: { a: [1] } })],
  ])('is refused when it holds %s, even signed with the right key', (_name, change) => {
    const { codec } = rig();
    const [version, payload] = codec.mint(binding, position).split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const body = Buffer.from(JSON.stringify(change(decoded)), 'utf8').toString('base64url');
    const signed = `${version}.${body}`;
    invalidated(() => codec.verify(`${signed}.${createHashHmac(signed)}`, binding));
  });

  it('is refused when the payload is not JSON, even signed with the right key', () => {
    const { codec } = rig();
    const signed = `v1.${Buffer.from('not json', 'utf8').toString('base64url')}`;
    invalidated(() => codec.verify(`${signed}.${createHashHmac(signed)}`, binding));
  });

  it.each([
    ['padding added to the mac', (c: string) => `${c}=`],
    ['padding added to the payload', (c: string) => c.replace(/^(v1\.[^.]+)\./, '$1=.')],
    ['a character outside the alphabet', (c: string) => c.replace(/.$/, '+')],
    ['the standard alphabet in place of base64url', (c: string) => c.replace(/-/g, '+').replace(/_/g, '/') + '/'],
    ['a space', (c: string) => ` ${c}`],
  ])('is refused when it has a second spelling: %s', (_name, change) => {
    const { codec } = rig();
    invalidated(() => codec.verify(change(codec.mint(binding, position)), binding));
  });

  it('is refused for a MAC whose last character is a non-canonical spelling of the same bytes', () => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    const last = cursor.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // a 32-byte MAC ends in 2 spare bits: a last character that differs only in those bits decodes to the same bytes
    const sibling = alphabet[alphabet.indexOf(last) ^ 1] ?? 'A';
    invalidated(() => codec.verify(cursor.slice(0, -1) + sibling, binding));
  });

  it('answers the same error for every failure, with no detail', () => {
    const { codec } = rig();
    const cursor = codec.mint(binding, position);
    const failures = [() => codec.verify('', binding), () => codec.verify(`${cursor}x`, binding), () => codec.verify(cursor, { ...binding, principal: 'z' }), () => codec.verify(rig(OTHER_KEY).codec.mint(binding, position), binding)];
    for (const failure of failures) {
      try {
        failure();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toMatchObject({ code: 'CURSOR_INVALIDATED', details: undefined, reason: undefined, message: 'CURSOR_INVALIDATED' });
      }
    }
  });
});

describe('minting a cursor', () => {
  it.each([
    ['a nested object', { a: { b: 1 } }],
    ['a list', { a: [1] }],
    ['a value that is not text, a number, a boolean or null', { a: undefined }],
    ['a date', { a: new Date() }],
    ['a number that is not finite', { a: Number.POSITIVE_INFINITY }],
    ['NaN', { a: Number.NaN }],
    ['a big integer', { a: 10n }],
    ['a nested object under a field named __proto__', JSON.parse('{"__proto__": {"a": 1}}')],
  ])('is refused for a position with %s, as an internal error with nothing of the position in it', (_name, bad) => {
    const { codec } = rig();
    try {
      codec.mint(binding, bad as never);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(error)).not.toContain('Infinity');
    }
  });

  it.each([
    ['a date', new Date()],
    ['an instance of a class', new (class Place {})()],
    ['a list', [1, 2]],
    ['text', 'position'],
    ['null', null],
    ['undefined', undefined],
  ])('is refused for a position that is %s, which is not a flat record', (_name, bad) => {
    const { codec } = rig();
    expect(() => codec.mint(binding, bad as never)).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('keeps every own field of the position, a field named __proto__ included, and gives back what it was given', () => {
    const { codec } = rig();
    const given = JSON.parse('{"__proto__": "kept", "a": 1, "b": null}') as Record<string, unknown>;
    const back = codec.verify(codec.mint(binding, given as never), binding) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(back).sort()).toEqual(['__proto__', 'a', 'b']);
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toBe('kept');
    expect(back['a']).toBe(1);
    expect(back['b']).toBeNull();
  });

  it('refuses at verification a signed payload whose position holds a nested value under __proto__', () => {
    const { codec } = rig();
    const [version, payload] = codec.mint(binding, position).split('.');
    const decoded = Buffer.from(payload ?? '', 'base64url').toString('utf8').replace(/"d":\{.*\}\}$/, '"d":{"__proto__":{"a":1}}}');
    const body = Buffer.from(decoded, 'utf8').toString('base64url');
    const signed = `${version}.${body}`;
    expect(decoded).toContain('"__proto__":{"a":1}');
    invalidated(() => codec.verify(`${signed}.${createHashHmac(signed)}`, binding));
  });

  it('accepts an empty position', () => {
    const { codec } = rig();
    expect(codec.verify(codec.mint(binding, {}), binding)).toEqual({});
  });
});

describe('the comparison of the MAC', () => {
  it('uses the constant-time function and never an equality operator on the MAC', () => {
    const source = readFileSync(fileURLToPath(new URL('./codec.ts', import.meta.url)), 'utf8');
    expect(source).toContain('timingSafeEqual(macBytes, expected)');
    expect(source).not.toMatch(/(macBytes|expected)\s*[!=]==\s*(macBytes|expected)/);
    expect(source).not.toMatch(/\.equals\(|localeCompare/);
  });
});

describe('the filter hash', () => {
  const KEY = Buffer.alloc(32, 3);

  it('is the HMAC-SHA-256 under the key of the canonical JSON of the parameters, computed here independently of the code under test', () => {
    const params = { b: [3, { y: 1, x: 2 }], a: 'text', c: null, d: 1.5 };
    const canonical = '{"a":"text","b":[3,{"x":2,"y":1}],"c":null,"d":1.5}';
    expect(filterHashOf(params, KEY)).toBe(createHmac('sha256', KEY).update(canonical).digest('hex'));
  });

  it('is the same when the keys of an object come in another order, and differs when a value changes', () => {
    expect(filterHashOf({ a: 1, b: { x: 1, y: 2 } }, KEY)).toBe(filterHashOf({ b: { y: 2, x: 1 }, a: 1 }, KEY));
    expect(filterHashOf({ a: 1 }, KEY)).not.toBe(filterHashOf({ a: 2 }, KEY));
    expect(filterHashOf({ a: [1, 2] }, KEY)).not.toBe(filterHashOf({ a: [2, 1] }, KEY));
  });

  it('is not the plain SHA-256 of the parameters, differs under another key, and cannot be recomputed without the key', () => {
    const params = { stableId: '+1-212-555-0100' };
    const plain = createHash('sha256').update(canonicalJson(params)).digest('hex');
    expect(filterHashOf(params, KEY)).not.toBe(plain);
    expect(filterHashOf(params, KEY)).not.toBe(filterHashOf(params, Buffer.alloc(32, 4)));
  });

  it('ignores a key whose value is undefined, as JSON does', () => {
    expect(filterHashOf({ a: 1, b: undefined }, KEY)).toBe(filterHashOf({ a: 1 }, KEY));
  });
});

function createHashHmac(signed: string): string {
  return createHmac('sha256', KEY).update(signed).digest('base64url');
}

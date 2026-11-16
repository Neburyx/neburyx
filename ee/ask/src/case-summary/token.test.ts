import { describe, expect, it } from 'vitest';
import { openToken, sealToken, TOKEN_LIFETIME_MS, type SealInput } from './token.js';
import type { TokenKeys } from './token-keys.js';

const CURRENT = { kid: 'cur00001', bytes: Buffer.alloc(32, 1) };
const PREVIOUS = { kid: 'prev0001', bytes: Buffer.alloc(32, 2) };
const KEYS: TokenKeys = { current: CURRENT, previous: PREVIOUS };
const INPUT: SealInput = {
  investigationId: 'inv-1',
  generatedBy: 'person-1',
  policyVersion: 'p1',
  modelRef: 'claude-sonnet-5-5',
  promptId: 'case-summary',
  promptVersion: '1',
  sentences: [{ text: 'Two accounts share a device.', cites: ['n1', 'n2'] }],
  inputRefs: [
    { key: 'n1', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } },
    { key: 'n2', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-2' } },
    { key: 'n3', kind: 'entity', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-3' } },
  ],
  propertyValuesSent: true,
  runId: '0192f000-0000-7000-8000-0000000000aa',
  mask: false,
  wordListVersion: 1,
  templates: [{ storable: false, reason: 'unlisted-word' }],
};
const CONTEXT = { investigationId: 'inv-1', actorId: 'person-1', policyVersion: 'p1', now: 1_000 };
const NOW = 1_000;

describe('the sealed summary token', () => {
  it('opens for the investigation, person and policy version it was drafted for, holding everything the draft holds', () => {
    const token = sealToken(KEYS, INPUT, NOW);
    const opened = openToken(KEYS, token, { ...CONTEXT, now: NOW + 1 });
    expect(opened.ok && opened.payload).toMatchObject({ ...INPUT, generatedAt: NOW, expiresAt: NOW + TOKEN_LIFETIME_MS });
    expect(opened.ok && opened.payload.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(opened.ok && opened.payload.inputRefs.map((entry) => entry.key)).toEqual(['n1', 'n2', 'n3']);
  });

  it('is sealed with AES-256-GCM, names the key in its header and holds no sentence in the clear', () => {
    const token = sealToken(KEYS, INPUT, NOW);
    expect(token.split('.').slice(0, 2)).toEqual(['v1', 'cur00001']);
    expect(token).not.toContain('Two accounts');
    expect(Buffer.from(token.split('.')[3] ?? '', 'base64url').toString('utf8')).not.toContain('Two accounts');
  });

  it('is a different token each time for the same draft', () => {
    expect(sealToken(KEYS, INPUT, NOW)).not.toBe(sealToken(KEYS, INPUT, NOW));
  });

  it.each([
    ['another investigation', { investigationId: 'inv-2' }],
    ['another person', { actorId: 'person-2' }],
    ['a changed policy version', { policyVersion: 'p2' }],
  ])('is refused for %s', (_name, change) => {
    const token = sealToken(KEYS, INPUT, NOW);
    expect(openToken(KEYS, token, { ...CONTEXT, now: NOW + 1, ...change })).toEqual({ ok: false });
  });

  it('is refused once its 30 minutes are spent', () => {
    const token = sealToken(KEYS, INPUT, NOW);
    expect(openToken(KEYS, token, { ...CONTEXT, now: NOW + TOKEN_LIFETIME_MS - 1 }).ok).toBe(true);
    expect(openToken(KEYS, token, { ...CONTEXT, now: NOW + TOKEN_LIFETIME_MS })).toEqual({ ok: false });
  });

  it.each([0, 2, 3, 4])('is refused when the byte of part %i is changed', (part) => {
    const token = sealToken(KEYS, INPUT, NOW);
    const parts = token.split('.');
    const changed = parts[part] ?? '';
    parts[part] = `${changed.slice(0, -2)}${changed.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(openToken(KEYS, parts.join('.'), { ...CONTEXT, now: NOW + 1 })).toEqual({ ok: false });
  });

  it('is refused when the key id is changed to another key id, and for an unknown one', () => {
    const token = sealToken(KEYS, INPUT, NOW);
    expect(openToken(KEYS, token.replace('cur00001', 'prev0001'), { ...CONTEXT, now: NOW + 1 })).toEqual({ ok: false });
    expect(openToken(KEYS, token.replace('cur00001', 'unknown1'), { ...CONTEXT, now: NOW + 1 })).toEqual({ ok: false });
  });

  it.each(['', 'v1', 'v1.a.b.c', 'v2.cur00001.a.b.c', 'not a token at all'])('is refused for the text %j', (text) => {
    expect(openToken(KEYS, text, CONTEXT)).toEqual({ ok: false });
  });

  it('opens a token sealed with the previous key for the rest of its 30 minutes, and not one older', () => {
    const old = sealToken({ current: PREVIOUS }, INPUT, NOW);
    expect(openToken(KEYS, old, { ...CONTEXT, now: NOW + 10 * 60_000 }).ok).toBe(true);
    expect(openToken(KEYS, old, { ...CONTEXT, now: NOW + 31 * 60_000 })).toEqual({ ok: false });
  });

  it('does not open a token sealed with the previous key once that key is no longer set', () => {
    const old = sealToken({ current: PREVIOUS }, INPUT, NOW);
    expect(openToken({ current: CURRENT }, old, { ...CONTEXT, now: NOW + 1 })).toEqual({ ok: false });
  });

  it('holds the flag of property values as it was drafted, in both cases', () => {
    for (const flag of [true, false]) {
      const opened = openToken(KEYS, sealToken(KEYS, { ...INPUT, propertyValuesSent: flag }, NOW), { ...CONTEXT, now: NOW + 1 });
      expect(opened.ok && opened.payload.propertyValuesSent).toBe(flag);
    }
  });
});

describe('the sealed templates of a token', () => {
  it('holds the run, the masking, the word list version and the stored form of each sentence, and opens with them', () => {
    const token = sealToken(KEYS, { ...INPUT, mask: true, templates: [{ storable: true, text: 'A listed sentence.', placeholders: [] }] }, NOW);
    const opened = openToken(KEYS, token, { ...CONTEXT, now: NOW + 1 });
    expect(opened.ok && opened.payload).toMatchObject({ runId: INPUT.runId, mask: true, wordListVersion: 1, templates: [{ storable: true, text: 'A listed sentence.', placeholders: [] }] });
  });

  it('refuses a token of the earlier form, which holds no templates, as it refuses any other token', () => {
    const { templates: _templates, ...older } = INPUT;
    const token = sealToken(KEYS, older as SealInput, NOW);
    expect(openToken(KEYS, token, { ...CONTEXT, now: NOW + 1 })).toEqual({ ok: false });
  });
});

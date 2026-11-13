import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalPreview, hashesMatch, previewHashOf, type PreviewMac, type PreviewParts } from './preview-hash.js';

const mac = (key: string): PreviewMac => (canonical) => createHmac('sha256', key).update(canonical).digest('hex');

const PARTS: PreviewParts = {
  text: 'which widgets share a gadget with ‹widget#1›?',
  resolutions: [{ start: 3, end: 9, ref: { sourceId: 's', entityType: 'widget', stableId: 'w-1' } }],
  policyVersion: 'none',
  wordListVersion: 'common-words-1',
};

describe('the preview hash', () => {
  it('is 64 lowercase hex characters and the same for the same parts', () => {
    const hash = previewHashOf(mac('k'), PARTS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(previewHashOf(mac('k'), { ...PARTS })).toBe(hash);
  });

  it('differs when the text, a resolution, the policy version, the word-list version or the key differs', () => {
    const hash = previewHashOf(mac('k'), PARTS);
    const others = [
      previewHashOf(mac('k'), { ...PARTS, text: `${PARTS.text} ` }),
      previewHashOf(mac('k'), { ...PARTS, resolutions: [{ start: 4, end: 9, ref: { sourceId: 's', entityType: 'widget', stableId: 'w-1' } }] }),
      previewHashOf(mac('k'), { ...PARTS, resolutions: [] }),
      previewHashOf(mac('k'), { ...PARTS, policyVersion: 'two' }),
      previewHashOf(mac('k'), { ...PARTS, wordListVersion: 'common-words-2' }),
      previewHashOf(mac('other'), PARTS),
    ];
    expect(new Set([hash, ...others]).size).toBe(others.length + 1);
  });

  it('does not depend on the order of the resolutions or of the keys inside one', () => {
    const one = { start: 0, end: 4, value: true as const };
    const two = { start: 6, end: 9, ref: { sourceId: 's', entityType: 'widget', stableId: 'w-1' } };
    const reordered = { start: 6, end: 9, ref: { stableId: 'w-1', entityType: 'widget', sourceId: 's' } };
    expect(canonicalPreview({ ...PARTS, resolutions: [one, two] })).toBe(canonicalPreview({ ...PARTS, resolutions: [reordered, one] }));
  });

  it('refuses a signature that is not a hash', () => {
    expect(() => previewHashOf(() => 'short', PARTS)).toThrow('64 lowercase hex');
  });
});

describe('comparing hashes', () => {
  const hash = previewHashOf(mac('k'), PARTS);

  it('matches equal hashes and nothing else', () => {
    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, previewHashOf(mac('x'), PARTS))).toBe(false);
  });

  it('never matches a value that is not a hash', () => {
    for (const offered of ['', 'abc', hash.toUpperCase(), `${hash}0`, hash.slice(1), 'g'.repeat(64)]) expect(hashesMatch(offered, hash)).toBe(false);
  });
});

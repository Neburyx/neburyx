import { describe, expect, it } from 'vitest';
import { deepLinkPath, readDeepLink, type DeepLink } from './deep-link.js';

const ORIGIN = 'https://neburyx.example.test';
const read = (text: string) => readDeepLink(text, ORIGIN);
const link = (overrides: Partial<DeepLink> = {}): DeepLink => ({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'AC-1', ...overrides });

describe('a link of this app', () => {
  it.each([
    ['a path', '/source-a/entity/kind-a/AC-1', link()],
    ['a path with a case reference', '/source-a/entity/kind-a/AC-1?caseRef=REF-1', link({ caseRef: 'REF-1' })],
    ['an address of the app’s own origin', `${ORIGIN}/source-a/entity/kind-a/AC-1?caseRef=REF-1`, link({ caseRef: 'REF-1' })],
    ['a path with spaces around it', '  /source-a/entity/kind-a/AC-1  ', link()],
    ['an encoded stable ID', '/source-a/entity/kind-a/AC%2F1', link({ stableId: 'AC/1' })],
    ['a dotted source ID', '/a.b_c-d/entity/kind-a/AC-1', link({ sourceId: 'a.b_c-d' })],
  ])('is read from %s', (_name, text, expected) => {
    expect(read(text)).toEqual({ ok: true, link: expected });
  });

  it.each(['.', '..', '~', '~.', '~..', '...', 'a/b', 'a b', '100%', '%2F', '%252F', 'Zoë', '日本', 'a?b#c&d=e', '+', 'a+b', '"quoted"'])('builds a path that reads back the same stable ID and case reference: %s', (value) => {
    const original = link({ entityType: value, stableId: value, caseRef: value });
    const path = deepLinkPath(original);
    expect(path).toMatch(/^\/source-a\/entity\/[^/?#]+\/[^/?#]+\?caseRef=[^&#]+$/);
    expect(read(path)).toEqual({ ok: true, link: original });
    expect(read(`${ORIGIN}${path}`)).toEqual({ ok: true, link: original });
  });

  it('makes a dot-only value travel with a tilde in front, and no other value', () => {
    expect(deepLinkPath(link({ stableId: '..' }))).toBe('/source-a/entity/kind-a/~..');
    expect(deepLinkPath(link({ stableId: '~' }))).toBe('/source-a/entity/kind-a/~~');
    expect(deepLinkPath(link({ stableId: 'AC-1' }))).toBe('/source-a/entity/kind-a/AC-1');
  });

  it('decodes a value once: encoded text that looks encoded stays as text', () => {
    expect(read('/source-a/entity/kind-a/%252F')).toEqual({ ok: true, link: link({ stableId: '%2F' }) });
  });
});

describe('text that is not a link', () => {
  const long = (length: number) => 'x'.repeat(length);
  it.each([
    ['nothing', ''],
    ['a word', 'hello'],
    ['too few segments', '/source-a/entity/kind-a'],
    ['too many segments', '/source-a/entity/kind-a/AC-1/more'],
    ['a trailing slash', '/source-a/entity/kind-a/AC-1/'],
    ['a middle segment other than entity', '/source-a/entities/kind-a/AC-1'],
    ['an empty type', '/source-a/entity//AC-1'],
    ['an empty stable ID', '/source-a/entity/kind-a/'],
    ['a bare tilde stable ID', '/source-a/entity/kind-a/~'],
    ['a bad percent escape', '/source-a/entity/kind-a/AC%ZZ'],
    ['a truncated percent escape', '/source-a/entity/kind-a/AC%'],
    ['a stable ID of 201 characters', `/source-a/entity/kind-a/${long(201)}`],
    ['a source ID that starts with a dot', '/.hidden/entity/kind-a/AC-1'],
    ['a source ID that starts with a dash', '/-x/entity/kind-a/AC-1'],
    ['a source ID with a percent sign', '/a%2Fb/entity/kind-a/AC-1'],
    ['another query parameter', '/source-a/entity/kind-a/AC-1?x=1'],
    ['two parameters', '/source-a/entity/kind-a/AC-1?caseRef=A&x=1'],
    ['a repeated caseRef', '/source-a/entity/kind-a/AC-1?caseRef=A&caseRef=B'],
    ['an empty caseRef', '/source-a/entity/kind-a/AC-1?caseRef='],
    ['a caseRef without a value sign', '/source-a/entity/kind-a/AC-1?caseRef'],
    ['a case reference of 101 characters', `/source-a/entity/kind-a/AC-1?caseRef=${long(101)}`],
    ['a bad percent escape in the case reference', '/source-a/entity/kind-a/AC-1?caseRef=%E0%A4%A'],
    ['a fragment', '/source-a/entity/kind-a/AC-1#top'],
    ['an empty fragment', '/source-a/entity/kind-a/AC-1#'],
  ])('is malformed: %s', (_name, text) => {
    expect(read(text)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('counts a limit in characters, not in bytes', () => {
    expect(read(`/source-a/entity/kind-a/${encodeURIComponent('é'.repeat(200))}`).ok).toBe(true);
    expect(read(`/source-a/entity/kind-a/${encodeURIComponent('é'.repeat(201))}`).ok).toBe(false);
    expect(read(`/source-a/entity/kind-a/AC-1?caseRef=${encodeURIComponent('é'.repeat(100))}`).ok).toBe(true);
    expect(read(`/source-a/entity/kind-a/AC-1?caseRef=${encodeURIComponent('é'.repeat(101))}`).ok).toBe(false);
  });

  it.each([
    ['another host', 'https://evil.example.test/source-a/entity/kind-a/AC-1'],
    ['the same host on another port', 'https://neburyx.example.test:8443/source-a/entity/kind-a/AC-1'],
    ['another scheme of the same host', 'http://neburyx.example.test/source-a/entity/kind-a/AC-1'],
    ['a javascript address', 'javascript:alert(1)'],
    ['a javascript address that ends like a link', 'javascript://neburyx.example.test/%0Aalert(1)//source-a/entity/kind-a/AC-1'],
    ['a data address', 'data:text/html,<script>alert(1)</script>'],
    ['a file address', 'file:///source-a/entity/kind-a/AC-1'],
    ['an ftp address', 'ftp://neburyx.example.test/source-a/entity/kind-a/AC-1'],
    ['a protocol-relative address', '//evil.example.test/source-a/entity/kind-a/AC-1'],
    ['a backslash form', '/\\evil.example.test/source-a/entity/kind-a/AC-1'],
    ['a backslash path', '\\source-a\\entity\\kind-a\\AC-1'],
    ['an address with credentials', 'https://user:pass@evil.example.test/source-a/entity/kind-a/AC-1'],
  ])('is refused as not a link of this app: %s', (_name, text) => {
    expect(read(text)).toEqual({ ok: false, reason: 'foreign' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildLinkAddress, SOURCE_LINK_MAX_LENGTH } from './link-address.js';
import { entityLinkFor, type LinkTemplate } from './model.js';

const path: LinkTemplate = { kind: 'entity', template: 'https://records.example.test/items/{id}/view', placeholder: 'id' };
const query: LinkTemplate = { kind: 'evidence', template: 'https://records.example.test/view?kind=a&item={recordId}', placeholder: 'recordId' };

describe('buildLinkAddress', () => {
  it('puts a value in one segment or one query value, percent-encoded', () => {
    expect(buildLinkAddress(path, 'A-1')).toBe('https://records.example.test/items/A-1/view');
    expect(buildLinkAddress(query, 'R 1&x=2')).toBe('https://records.example.test/view?kind=a&item=R%201%26x%3D2');
  });

  it.each(['/', '?', '#', '%', '\\', ' ', '\n', '@', '//evil.test', '../x', 'a/../b', 'https://evil.test'])('keeps the host and path of the template for the value %j', (value) => {
    const address = buildLinkAddress(path, value);
    expect(address).toBeDefined();
    const url = new URL(address ?? '');
    expect(url.host).toBe('records.example.test');
    expect(url.pathname.startsWith('/items/')).toBe(true);
    expect(url.pathname.endsWith('/view')).toBe(true);
    expect(url.username).toBe('');
    expect(url.hash).toBe('');
  });

  it.each(['.', '..', '...', '\ud800', 'a\udc00b', 'x'.repeat(SOURCE_LINK_MAX_LENGTH)])('builds no address, and does not throw, for the value %j', (value) => {
    expect(buildLinkAddress(path, value)).toBeUndefined();
  });

  it('builds an address of exactly the limit and none one character longer', () => {
    const fixed = buildLinkAddress(path, '')?.length ?? 'https://records.example.test/items//view'.length;
    expect(buildLinkAddress(path, 'a'.repeat(SOURCE_LINK_MAX_LENGTH - fixed))?.length).toBe(SOURCE_LINK_MAX_LENGTH);
    expect(buildLinkAddress(path, 'a'.repeat(SOURCE_LINK_MAX_LENGTH - fixed + 1))).toBeUndefined();
  });

  it('returns the ASCII form for a template with a non-ASCII path or host, so it is safe in a header', () => {
    const accented = buildLinkAddress({ ...path, template: 'https://records.example.test/ü/{id}' }, 'A-1');
    expect(accented).toBe('https://records.example.test/%C3%BC/A-1');
    const idn = buildLinkAddress({ ...path, template: 'https://münchen.example.test/items/{id}' }, 'ü');
    expect(idn).toBe('https://xn--mnchen-3ya.example.test/items/%C3%BC');
    for (const address of [accented, idn]) expect(address).toMatch(/^[\x20-\x7e]+$/);
  });

  it('builds no address from a template whose host is not fixed or whose scheme is not https', () => {
    expect(buildLinkAddress({ ...path, template: 'http://records.example.test/items/{id}' }, 'A')).toBeUndefined();
    expect(buildLinkAddress({ ...path, template: 'https://user@records.example.test/items/{id}' }, 'A')).toBeUndefined();
    expect(buildLinkAddress({ ...path, template: 'https://{id}.example.test/items' }, 'evil.test/x')).toBeUndefined();
  });
});

describe('entityLinkFor', () => {
  it('builds no address for a keyed type while masked or without the opt-in, and builds it from the raw value otherwise', () => {
    const entity = { stableId: 'idNo', pii: ['idNo'], link: { ...path, placeholder: 'idNo', template: 'https://records.example.test/p/{idNo}', carriesValue: true as const } };
    expect(entityLinkFor(entity, 'ID 1', true)).toBeUndefined();
    expect(entityLinkFor(entity, 'ID 1', false)).toBe('https://records.example.test/p/ID%201');
    const { carriesValue: _opt, ...plain } = entity.link;
    expect(entityLinkFor({ ...entity, link: plain }, 'ID 1', false)).toBeUndefined();
  });
});

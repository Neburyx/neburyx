import { describe, expect, it } from 'vitest';
import { baseSource, expectRefused, firstSource, issuesOf, fileOf, load, type Json } from '../testing/mapping.js';
import { checkLink, LINK_TEMPLATE_MAX_LENGTH, type LinkRules } from './links.js';

const entityRules: LinkRules = { kind: 'entity', allowed: ['id', 'id/part', 'id?part', 'id#part', 'a&b'], allowedDescription: 'the stable ID property', piiProperties: [] };
const evidenceRules: LinkRules = { kind: 'evidence', allowed: ['recordId', 'batchId', 'id/part', 'id?part', 'id#part'], allowedDescription: 'one of the evidence properties', piiProperties: [] };

function entityWith(link: string): Json {
  return baseSource({ entities: [{ type: 'node_a', label: 'NodeA', stable_id: 'id', link }], relationships: undefined });
}

function relationshipWith(evidenceLink: string, evidence: Json = { evidence: ['recordId', 'batchId'] }): Json {
  return baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b', ...evidence, evidence_link: evidenceLink }] });
}

function reasonsOf(template: string, rules: LinkRules): readonly string[] {
  const check = checkLink(template, rules);
  return check.status === 'invalid' ? check.reasons : [];
}

describe('valid links', () => {
  it.each([
    'https://records.example.test/items/{id}',
    'https://records.example.test/items/{id}/view',
    'https://records.example.test/view?item={id}',
    'https://records.example.test/view?kind=a&item={id}',
    'HTTPS://records.example.test/items/{id}',
    'https://records.example.test:8443/items/{id}',
  ])('keeps the entity link %s with its kind and placeholder', (template) => {
    expect(checkLink(template, entityRules)).toEqual({ status: 'valid', link: { kind: 'entity', template, placeholder: 'id' } });
  });

  it.each(['id/part', 'id?part', 'id#part'])('keeps a placeholder named %s as a whole path segment or query value', (name) => {
    for (const template of [`https://records.example.test/items/{${name}}`, `https://records.example.test/view?item={${name}}`]) {
      expect(checkLink(template, entityRules)).toMatchObject({ status: 'valid', link: { placeholder: name } });
      expect(checkLink(template, evidenceRules)).toMatchObject({ status: 'valid', link: { kind: 'evidence', placeholder: name } });
    }
  });

  it('still refuses a delimiter-named placeholder that is only part of a segment or in a query key', () => {
    expect(reasonsOf('https://records.example.test/items/x-{id/part}', entityRules).join()).toContain('not a whole path segment');
    expect(reasonsOf('https://records.example.test/view?{id?part}=1', entityRules).join()).toContain('placeholder in a query key');
    expect(reasonsOf('https://records.example.test/view#{id#part}', entityRules).join()).toContain('placeholder in the fragment');
  });

  it('keeps an evidence link whose placeholder is one of the evidence properties', () => {
    const template = 'https://audit.example.test/records/{batchId}';
    expect(checkLink(template, evidenceRules)).toEqual({ status: 'valid', link: { kind: 'evidence', template, placeholder: 'batchId' } });
  });

  it('keeps the link template and kind in the loaded model, with no address built', () => {
    const entity = firstSource(load(entityWith('https://records.example.test/items/{id}'))).entities[0];
    expect(entity?.link).toEqual({ kind: 'entity', template: 'https://records.example.test/items/{id}', placeholder: 'id' });
    const relationship = firstSource(load(relationshipWith('https://audit.example.test/records/{recordId}'))).relationships[0];
    expect(relationship?.evidenceLink).toMatchObject({ kind: 'evidence', placeholder: 'recordId' });
  });
});

describe('invalid links', () => {
  it.each([
    ['http scheme', 'http://records.example.test/items/{id}', 'has a scheme that is not https'],
    ['ftp scheme', 'ftp://records.example.test/items/{id}', 'has a scheme that is not https'],
    ['a script address', 'javascript:alert({id})', 'is not an absolute https address'],
    ['a scheme-relative address', '//records.example.test/items/{id}', 'is not an absolute https address'],
    ['a relative path', '/items/{id}', 'is not an absolute https address'],
    ['a placeholder in the host', 'https://{id}.example.test/items', 'placeholder in the scheme or host'],
    ['a placeholder as the host', 'https://{id}/items', 'placeholder in the scheme or host'],
    ['a placeholder in the user-info', 'https://{id}@records.example.test/items', 'placeholder in the scheme or host'],
    ['a placeholder in the port', 'https://records.example.test:{id}/items', 'placeholder in the scheme or host'],
    ['a placeholder in the scheme', '{id}://records.example.test/items', 'is not an absolute https address'],
    ['part of a path segment', 'https://records.example.test/items/item-{id}', 'not a whole path segment'],
    ['part of a query value', 'https://records.example.test/view?item=n{id}', 'not a whole query value'],
    ['a query key', 'https://records.example.test/view?{id}=1', 'placeholder in a query key'],
    ['the fragment', 'https://records.example.test/view#{id}', 'placeholder in the fragment'],
    ['no placeholder', 'https://records.example.test/items', 'exactly one placeholder'],
    ['two placeholders', 'https://records.example.test/items/{id}/{id}', 'exactly one placeholder'],
    ['a stray brace', 'https://records.example.test/items/{id}}', 'exactly one placeholder'],
    ['an empty placeholder', 'https://records.example.test/items/{}', 'empty placeholder'],
    ['no host', 'https:///{id}', 'has no host'],
    ['an empty authority and extra slashes', 'https:////{id}', 'has no host'],
    ['an unknown property', 'https://records.example.test/items/{other}', 'is not the stable ID property'],
  ])('refuses an entity link with %s', (_name, template, reason) => {
    expect(reasonsOf(template, entityRules).join('; ')).toContain(reason);
  });

  it('refuses an entity link whose placeholder is a pii property, even when it is the stable ID', () => {
    const reasons = reasonsOf('https://records.example.test/items/{id}', { ...entityRules, piiProperties: ['id'] });
    expect(reasons).toContain('has placeholder id, which is marked pii');
  });

  it.each([
    ['a placeholder that is not an evidence property', 'https://audit.example.test/records/{id}', 'is not one of the evidence properties'],
    ['http scheme', 'http://audit.example.test/records/{recordId}', 'has a scheme that is not https'],
    ['a host placeholder', 'https://{recordId}.example.test/records', 'placeholder in the scheme or host'],
    ['a query key', 'https://audit.example.test/records?{recordId}=1', 'placeholder in a query key'],
    ['a fragment', 'https://audit.example.test/records#{recordId}', 'placeholder in the fragment'],
    ['a partial segment', 'https://audit.example.test/records/r-{recordId}', 'not a whole path segment'],
    ['two placeholders', 'https://audit.example.test/{recordId}/{batchId}', 'exactly one placeholder'],
    ['no host', 'https:///{recordId}', 'has no host'],
    ['an empty authority and extra slashes', 'https:////{recordId}', 'has no host'],
  ])('refuses an evidence link with %s', (_name, template, reason) => {
    expect(reasonsOf(template, evidenceRules).join('; ')).toContain(reason);
  });

  it('never repeats the template or its host in a reason', () => {
    const reasons = reasonsOf('http://secret-host.example.test/path/{id}', entityRules).join(' ');
    expect(reasons).not.toContain('secret-host');
  });
});

describe('links in a mapping file', () => {
  it('names the entity link path for a wrong scheme', () => {
    expectRefused(entityWith('http://records.example.test/items/{id}'), 'sources[0].entities[0].link', 'has a scheme that is not https', 'source demo, entity node_a');
  });

  it('names the entity link path for a host placeholder', () => {
    expectRefused(entityWith('https://{id}.example.test/items'), 'sources[0].entities[0].link', 'placeholder in the scheme or host');
  });

  it('refuses a placeholder that is not the stable ID', () => {
    expectRefused(entityWith('https://records.example.test/items/{name}'), 'sources[0].entities[0].link', 'has placeholder name');
  });

  it('refuses an evidence link on a relationship type with no evidence list', () => {
    for (const evidence of [{}, { evidence: [] }]) {
      expectRefused(relationshipWith('https://audit.example.test/records/{recordId}', evidence), 'sources[0].relationships[0].evidence_link', 'needs an evidence list');
    }
  });

  it('names the evidence link path for a placeholder that is not an evidence property', () => {
    expectRefused(relationshipWith('https://audit.example.test/records/{other}'), 'sources[0].relationships[0].evidence_link', 'has placeholder other', 'source demo, relationship LINKS');
  });

  it('does not repeat the host of a refused template in the message', () => {
    const issues = issuesOf(fileOf(entityWith('http://private-host.example.test/items/{id}')));
    expect(JSON.stringify(issues)).not.toContain('private-host');
  });
});

describe('links the template rules refuse (unsafe text)', () => {
  it.each([
    ['user-info before the host', 'https://user@records.example.test/items/{id}', 'has user-info before the host'],
    ['a password in the user-info', 'https://user:secret@records.example.test/items/{id}', 'has user-info before the host'],
    ['a space', 'https://records.example.test/items {id}', 'whitespace, control character or backslash'],
    ['a newline', 'https://records.example.test/items/{id}\nx', 'whitespace, control character or backslash'],
    ['a tab', 'https://records.example.test/\titems/{id}', 'whitespace, control character or backslash'],
    ['a backslash', 'https://records.example.test\\evil.test/items/{id}', 'whitespace, control character or backslash'],
    ['a NUL', 'https://records.example.test/items/{id}\u0000', 'whitespace, control character or backslash'],
    ['more characters than the limit', `https://records.example.test/${'a'.repeat(LINK_TEMPLATE_MAX_LENGTH)}/{id}`, 'is longer than'],
  ])('refuses %s without echoing the template', (_name, template, reason) => {
    const reasons = reasonsOf(template, entityRules);
    expect(reasons.join(' ')).toContain(reason);
    expect(reasons.join(' ')).not.toContain('records.example.test');
  });

  it('keeps a template of exactly the limit', () => {
    const template = `https://records.example.test/${'a'.repeat(LINK_TEMPLATE_MAX_LENGTH - 'https://records.example.test//{id}'.length)}/{id}`;
    expect(template.length).toBe(LINK_TEMPLATE_MAX_LENGTH);
    expect(checkLink(template, entityRules).status).toBe('valid');
  });

  it('reports a refused template against the key of the mapping and loads the mapping without the link', () => {
    expectRefused(entityWith('https://user@records.example.test/items/{id}'), 'sources[0].entities[0].link', 'user-info');
    expectRefused(relationshipWith('https://records.example.test/r/{recordId}\\x'), 'sources[0].relationships[0].evidence_link', 'backslash');
  });
});

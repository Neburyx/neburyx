// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_LINKS } from '../help/links.js';

const FOLDER = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(FOLDER).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name));
const textOf = (name: string): string => readFileSync(join(FOLDER, name), 'utf8');
const REQUESTS = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'new Image', '<img', 'EventSource', 'WebSocket', 'onClick'];

describe('the Enterprise link of the Sources page makes no request', () => {
  it('is an anchor with nothing that sends: no fetch, XMLHttpRequest, beacon, image, socket or click handler in its file', () => {
    const text = textOf('enterprise-link.tsx');
    expect(text).toContain('<a ');
    for (const request of REQUESTS) expect(text, request).not.toContain(request);
  });

  it('is named, by the value of the constant, by no file of the Sources folder', () => {
    const value = HELP_LINKS.enterprise;
    const host = value.startsWith('mailto:') ? value.slice('mailto:'.length) : new URL(value).host;
    expect(host).not.toBe('');
    for (const name of sources) {
      const text = textOf(name);
      expect(text, name).not.toContain(value);
      expect(text.includes(`//${host}`) || text.includes(`'${host}'`) || text.includes(`"${host}"`), name).toBe(false);
    }
  });
});

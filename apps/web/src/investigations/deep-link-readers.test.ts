// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const ROUTE_TEXT = /\/entity\/|\bentity\/\$\{|:entityType/;
const ALLOWED = new Set(['investigations/deep-link.ts', 'routes.tsx']);

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the deep-link route', () => {
  it('is built and read only by the one module of the deep link, and named only by the router', () => {
    const others = productionFiles(SRC)
      .filter((path) => ROUTE_TEXT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((path) => !ALLOWED.has(path));
    expect(others).toEqual([]);
  });
});

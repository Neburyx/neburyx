import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterVersions } from './environment.js';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spike-env-'));
  mkdirSync(join(root, 'canvas'));
  writeFileSync(join(root, 'canvas', 'package.json'), JSON.stringify({ name: 'canvas-lib', version: '9.1.0' }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('adapterVersions', () => {
  it('reads the name and version of each package file listed for a registered adapter', () => {
    expect(adapterVersions(root, 'product-canvas', { 'product-canvas': ['canvas/package.json'] })).toEqual({ 'canvas-lib': '9.1.0' });
  });

  it('gives no versions for an adapter nobody listed packages for, so the gap is visible in the report', () => {
    expect(adapterVersions(root, 'product-canvas', {})).toEqual({});
  });
});

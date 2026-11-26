import { describe, expect, it } from 'vitest';
import { createCursorCodec } from '../../../../services/api/src/gate/cursor/codec.js';
import { devCursorKey } from '../../../dev/src/cursor-key.js';
import type { Files } from '../../../dev/src/files.js';

const held = new Map<string, string>();
const files: Files = {
  exists: (path) => held.has(path),
  read: (path) => held.get(path) ?? '',
  mode: () => 0o600,
  realPath: (path) => path,
  createPrivate: (path, text) => !held.has(path) && (held.set(path, text), true),
};
const binding = { source: 'demo', principal: 'person', policyVersion: '1', filterHash: 'hash', sort: 'elementId', target: 'template', targetVersion: '1' };
const codecOf = (fill: number) => createCursorCodec({ key: Buffer.from(devCursorKey({}, '/home/dev/dev.env', '/repo', files, (bytes) => Buffer.alloc(bytes, fill)), 'base64'), clock: () => 0 });

describe('a page cursor of one development run', () => {
  it('is accepted by the next run, which keeps the key, and not by a run that made another', () => {
    const cursor = codecOf(1).mint(binding, { after: 'x' });
    expect(codecOf(2).verify(cursor, binding)).toEqual({ after: 'x' });
    held.clear();
    expect(() => codecOf(2).verify(cursor, binding)).toThrow();
  });
});

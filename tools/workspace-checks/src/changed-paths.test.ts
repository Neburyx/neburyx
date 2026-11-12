import { describe, expect, it } from 'vitest';
import * as script from '../../ci/changed-paths.mjs';

const exec = (stdout: string, status = 0) => (): { status: number; stdout: string } => ({ status, stdout });

describe('which slow steps a list of changed files calls for', () => {
  it.each([
    ['deploy/docker/Dockerfile', { image: true, quickstart: true }],
    ['deploy/demo/compose.yaml', { image: true, quickstart: true }],
    ['pnpm-lock.yaml', { image: true, quickstart: false }],
    ['package.json', { image: true, quickstart: false }],
    ['.nvmrc', { image: true, quickstart: false }],
    ['.github/workflows/ci.yml', { image: true, quickstart: false }],
    ['README.md', { image: false, quickstart: true }],
    ['services/api/src/compose/readme-quickstart.compose.test.ts', { image: false, quickstart: true }],
    ['services/api/src/compose/stack.ts', { image: false, quickstart: true }],
    ['services/api/vitest.compose.config.ts', { image: false, quickstart: true }],
    ['services/api/src/gate/gate.ts', { image: false, quickstart: false }],
    ['docs/README.md', { image: false, quickstart: false }],
    ['apps/web/package.json', { image: false, quickstart: false }],
    ['deployment-notes.md', { image: false, quickstart: false }],
    ['a path with spaces/deploy/x', { image: false, quickstart: false }],
  ])('%s', (path, expected) => {
    expect(script.classify([path])).toEqual(expected);
  });

  it('is false for an empty list, which is a read list that holds no file', () => {
    expect(script.classify([])).toEqual({ image: false, quickstart: false });
  });

  it('is true for both when the list could not be read, and never false by default', () => {
    expect(script.classify(undefined)).toEqual({ image: true, quickstart: true });
  });

  it('is true for a step when any one path of a long list calls for it', () => {
    expect(script.classify(['a.ts', 'b.ts', 'deploy/x'])).toEqual({ image: true, quickstart: true });
  });
});

describe('reading the changed paths between two revisions', () => {
  it('splits the NUL-separated list, keeping a path with a space and a renamed path whole', () => {
    expect(script.changedBetween('a1', 'b2', exec('one.ts\0dir with space/two.ts\0deploy/new name.yaml\0'))).toEqual(['one.ts', 'dir with space/two.ts', 'deploy/new name.yaml']);
  });

  it.each([undefined, '', '0000000000000000000000000000000000000000'])('has no list for the base %j', (base) => {
    expect(script.changedBetween(base, 'b2', exec('x\0'))).toBeUndefined();
  });

  it('has no list when there is no head, or when git fails (an unknown revision after a forced push)', () => {
    expect(script.changedBetween('a1', '', exec('x\0'))).toBeUndefined();
    expect(script.changedBetween('a1', 'b2', exec('', 128))).toBeUndefined();
  });

  it('lists a file moved out of a watched folder by its old path as well, so the move calls for the step', () => {
    expect(script.classify(script.changedBetween('a1', 'b2', exec('deploy/docker/entrypoint.sh\0scripts/entrypoint.sh\0')))).toEqual({ image: true, quickstart: true });
  });

  it('asks git for the names between the two revisions only, without rename detection', () => {
    const calls: (readonly string[])[] = [];
    script.changedBetween('a1', 'b2', (tool, args) => (calls.push([tool, ...args]), { status: 0, stdout: '' }));
    expect(calls).toEqual([['git', 'diff', '--name-only', '--no-renames', '-z', 'a1', 'b2']]);
  });
});

describe('the command', () => {
  const lines = (argv: string[], result: { status: number; stdout: string }) => {
    const written: string[] = [];
    const status = script.run(argv, () => result, (text) => written.push(text), () => undefined);
    return { status, written: written.join('') };
  };

  it('writes the two outputs in the form GitHub reads, true for a deploy change', () => {
    expect(lines(['--base', 'a1', '--head', 'b2'], { status: 0, stdout: 'deploy/docker/Dockerfile\0' })).toEqual({ status: 0, written: 'image=true\nquickstart=true\n' });
  });

  it('writes false for both when only product code changed', () => {
    expect(lines(['--base', 'a1', '--head', 'b2'], { status: 0, stdout: 'services/api/src/start.ts\0' })).toEqual({ status: 0, written: 'image=false\nquickstart=false\n' });
  });

  it('writes true for both when there is no base', () => {
    expect(lines(['--base', '', '--head', 'b2'], { status: 0, stdout: '' })).toEqual({ status: 0, written: 'image=true\nquickstart=true\n' });
  });

  it('refuses an unknown option, writing nothing', () => {
    expect(lines(['--bas', 'a1', '--head', 'b2'], { status: 0, stdout: '' })).toEqual({ status: 2, written: '' });
  });
});

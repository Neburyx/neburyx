import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('needs a folder after --record-dir', () => {
    expect(parseArgs(['--record-dir'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgs(['--record-dir', '--dry-run'])).toMatchObject({ kind: 'usage-error' });
  });

  it('reads the folder and the dry-run flag, and ignores a bare -- that pnpm may pass', () => {
    expect(parseArgs(['--', '--record-dir', '/x', '--dry-run'])).toEqual({ kind: 'run', options: { recordDir: '/x', dryRun: true } });
  });

  it('reads an image name after --image and needs one', () => {
    expect(parseArgs(['--record-dir', '/x', '--image', 'neburyx:rc'])).toEqual({ kind: 'run', options: { recordDir: '/x', dryRun: false, image: 'neburyx:rc' } });
    expect(parseArgs(['--record-dir', '/x', '--image'])).toMatchObject({ kind: 'usage-error' });
  });
});

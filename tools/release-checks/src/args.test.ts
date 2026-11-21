import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('needs a folder after --record-dir', () => {
    expect(parseArgs(['--record-dir'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgs(['--record-dir', '--dry-run'])).toMatchObject({ kind: 'usage-error' });
  });

  it('reads the folder and the dry-run flag, and ignores a bare -- that pnpm may pass', () => {
    expect(parseArgs(['--', '--record-dir', '/x', '--dry-run'])).toEqual({ kind: 'run', options: { recordDir: '/x', gate: 'v0.1', cut: [], dryRun: true } });
  });

  it('reads an image name after --image and needs one', () => {
    expect(parseArgs(['--record-dir', '/x', '--image', 'neburyx:rc'])).toEqual({ kind: 'run', options: { recordDir: '/x', gate: 'v0.1', cut: [], dryRun: false, image: 'neburyx:rc' } });
    expect(parseArgs(['--record-dir', '/x', '--image'])).toMatchObject({ kind: 'usage-error' });
  });

  it('reads the gate after --gate, takes gate 1 when none is given, and refuses an unknown gate and a missing name', () => {
    expect(parseArgs(['--record-dir', '/x', '--gate', 'ask-preview'])).toEqual({ kind: 'run', options: { recordDir: '/x', gate: 'ask-preview', cut: [], dryRun: false } });
    expect(parseArgs(['--record-dir', '/x', '--gate', 'v0.1'])).toMatchObject({ kind: 'run', options: { gate: 'v0.1' } });
    expect(parseArgs(['--record-dir', '/x', '--gate', 'v9'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgs(['--record-dir', '/x', '--gate'])).toMatchObject({ kind: 'usage-error' });
  });

  it('reads each --cut feature once for the Ask-preview gate, refuses an unknown feature and refuses --cut for another gate', () => {
    expect(parseArgs(['--record-dir', '/x', '--gate', 'ask-preview', '--cut', 'summary', '--cut', 'assistant', '--cut', 'summary'])).toMatchObject({ kind: 'run', options: { cut: ['summary', 'assistant'] } });
    expect(parseArgs(['--record-dir', '/x', '--gate', 'ask-preview', '--cut', 'ask'])).toMatchObject({ kind: 'usage-error' });
    expect(parseArgs(['--record-dir', '/x', '--cut', 'summary'])).toMatchObject({ kind: 'usage-error', message: '--cut applies to --gate ask-preview only' });
  });
});

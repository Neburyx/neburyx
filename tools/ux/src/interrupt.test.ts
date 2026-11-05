import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { restoreOnInterrupt } from './interrupt.ts';

function rig(failAt?: 'restoreSource' | 'rebuild', stopTakes = 0) {
  const log: string[] = [];
  const source = new EventEmitter();
  restoreOnInterrupt(source, {
    stopChildren: async () => {
      log.push('stop');
      await new Promise((resolve) => setTimeout(resolve, stopTakes));
      log.push('stopped');
    },
    restoreSource: () => {
      log.push('restore');
      if (failAt === 'restoreSource') throw new Error('disk');
    },
    rebuild: () => {
      log.push('rebuild');
      if (failAt === 'rebuild') throw new Error('build');
    },
    exit: (code) => void log.push(`exit ${code}`),
    report: (error) => void log.push(`reported ${(error as Error).message}`),
  });
  return { source, log };
}

describe('an interrupt of the broken binding check', () => {
  it.each([['SIGINT', 130], ['SIGTERM', 143]])('stops the children and waits for them, puts the source back, builds the app again and only then leaves, on %s', async (signal, code) => {
    const { source, log } = rig(undefined, 30);
    source.emit(signal);
    await vi.waitFor(() => expect(log).toContain(`exit ${code}`));
    expect(log).toEqual(['stop', 'stopped', 'restore', 'rebuild', `exit ${code}`]);
  });

  it('goes on to the next step when one fails, and leaves, and does the work once for two signals', async () => {
    const failing = rig('restoreSource');
    failing.source.emit('SIGINT');
    await vi.waitFor(() => expect(failing.log).toContain('exit 130'));
    expect(failing.log).toEqual(['stop', 'stopped', 'restore', 'reported disk', 'rebuild', 'exit 130']);
    const twice = rig();
    twice.source.emit('SIGINT');
    twice.source.emit('SIGTERM');
    await vi.waitFor(() => expect(twice.log).toContain('exit 130'));
    expect(twice.log).toEqual(['stop', 'stopped', 'restore', 'rebuild', 'exit 130']);
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { restoreOnInterrupt } from './interrupt.ts';

function rig(failAt?: 'restoreSource' | 'rebuild') {
  const log: string[] = [];
  const source = new EventEmitter();
  restoreOnInterrupt(source, {
    stopChildren: () => void log.push('stop'),
    restoreSource: () => {
      log.push('restore');
      if (failAt === 'restoreSource') throw new Error('disk');
    },
    rebuild: () => {
      log.push('rebuild');
      if (failAt === 'rebuild') throw new Error('build');
    },
    exit: (code) => void log.push(`exit ${code}`),
  });
  return { source, log };
}

describe('an interrupt of the broken binding check', () => {
  it.each([['SIGINT', 130], ['SIGTERM', 143]])('stops the children, puts the source back, builds the app again and only then leaves, on %s', (signal, code) => {
    const { source, log } = rig();
    source.emit(signal);
    expect(log).toEqual(['stop', 'restore', 'rebuild', `exit ${code}`]);
  });

  it('leaves even when a step fails, and does the work once for two signals', () => {
    const failing = rig('restoreSource');
    expect(() => failing.source.emit('SIGINT')).toThrow('disk');
    expect(failing.log).toEqual(['stop', 'restore', 'exit 130']);
    const twice = rig();
    twice.source.emit('SIGINT');
    twice.source.emit('SIGTERM');
    expect(twice.log).toEqual(['stop', 'restore', 'rebuild', 'exit 130']);
  });
});

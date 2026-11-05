import { describe, expect, it } from 'vitest';
import { checkBrokenBinding, type MutationCheck, type TestRun } from './mutation.ts';

const passing: TestRun = { failures: [] };
const caught: TestRun = { failures: [{ title: 'keyboard › the legend key opens the legend', message: 'expect(received).toBe(expected)\nExpected: true\nReceived: false' }] };

function rig(runs: TestRun[], overrides: Partial<MutationCheck> = {}): { readonly check: MutationCheck; readonly log: string[] } {
  const log: string[] = [];
  const queue = [...runs];
  const check: MutationCheck = {
    run: async () => {
      log.push('run');
      const next = queue.shift();
      if (next === undefined) throw new Error('no run left');
      return next;
    },
    breakBinding: async () => void log.push('break'),
    restore: async () => void log.push('restore'),
    expected: { title: 'the legend key opens the legend', assertion: /toBe\(expected\)/ },
    ...overrides,
  };
  return { check, log };
}

describe('the broken binding check', () => {
  it('runs pass, fail, pass, with the binding broken for the middle run and restored before the last', async () => {
    const { check, log } = rig([passing, caught, passing]);
    await checkBrokenBinding(check);
    expect(log).toEqual(['run', 'break', 'run', 'restore', 'run']);
  });

  it('fails when the broken binding makes no test fail, and still restores', async () => {
    const { check, log } = rig([passing, passing, passing]);
    await expect(checkBrokenBinding(check)).rejects.toThrow('MUTATION_NOT_CAUGHT');
    expect(log).toContain('restore');
  });

  it('fails when another test fails and not the named one, or the named one fails on something that is not its assertion', async () => {
    await expect(checkBrokenBinding(rig([passing, { failures: [{ title: 'another test', message: 'expect(received).toBe(expected)' }] }, passing]).check)).rejects.toThrow('MUTATION_NOT_CAUGHT');
    await expect(checkBrokenBinding(rig([passing, { failures: [{ title: 'the legend key opens the legend', message: 'Error: locator.focus: Timeout 30000ms exceeded' }] }, passing]).check)).rejects.toThrow('MUTATION_WRONG_FAILURE');
  });

  it('fails when the unbroken test fails first, without breaking anything, and when it fails after the restore', async () => {
    const first = rig([caught]);
    await expect(checkBrokenBinding(first.check)).rejects.toThrow('MUTATION_BASELINE_FAILS');
    expect(first.log).toEqual(['run']);
    await expect(checkBrokenBinding(rig([passing, caught, caught]).check)).rejects.toThrow('MUTATION_RESTORE_FAILS');
  });

  it('restores when the run of the broken app throws', async () => {
    const log: string[] = [];
    let runs = 0;
    const check: MutationCheck = {
      run: async () => {
        runs += 1;
        if (runs === 2) throw new Error('the browser died');
        return passing;
      },
      breakBinding: async () => void log.push('break'),
      restore: async () => void log.push('restore'),
      expected: { title: 'x', assertion: /x/ },
    };
    await expect(checkBrokenBinding(check)).rejects.toThrow('the browser died');
    expect(log).toEqual(['break', 'restore']);
  });
});

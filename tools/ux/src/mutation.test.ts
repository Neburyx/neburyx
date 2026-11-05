import { describe, expect, it } from 'vitest';
import { checkBrokenBinding, type MutationCheck, type TestRun } from './mutation.ts';

const passing: TestRun = { failures: [], errors: [], passed: 1 };
const caught: TestRun = { failures: [{ title: 'keyboard › the legend key opens the legend', message: 'expect(received).toBe(expected)\nExpected: true\nReceived: false' }], errors: [], passed: 0 };

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
    await expect(checkBrokenBinding(rig([passing, { failures: [{ title: 'another test', message: 'expect(received).toBe(expected)' }], errors: [], passed: 0 }, passing]).check)).rejects.toThrow('MUTATION_NOT_CAUGHT');
    await expect(checkBrokenBinding(rig([passing, { failures: [{ title: 'the legend key opens the legend', message: 'Error: locator.focus: Timeout 30000ms exceeded' }], errors: [], passed: 0 }, passing]).check)).rejects.toThrow('MUTATION_WRONG_FAILURE');
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

  it('fails when a run ended with an error outside the tests, in any of the three runs, also when its tests passed', async () => {
    const broken: TestRun = { failures: [], errors: ['the global teardown threw'], passed: 1 };
    await expect(checkBrokenBinding(rig([broken, caught, passing]).check)).rejects.toThrow('MUTATION_RUN_ERROR');
    await expect(checkBrokenBinding(rig([passing, { ...caught, errors: ['the browser crashed'] }, passing]).check)).rejects.toThrow('MUTATION_RUN_ERROR');
    await expect(checkBrokenBinding(rig([passing, caught, broken]).check)).rejects.toThrow('MUTATION_RESTORE_FAILS');
  });

  it('fails when no test ran in the first or the last run, and when an unrelated test fails beside the expected one', async () => {
    await expect(checkBrokenBinding(rig([{ failures: [], errors: [], passed: 0 }, caught, passing]).check)).rejects.toThrow('MUTATION_NO_TEST_RAN');
    await expect(checkBrokenBinding(rig([passing, caught, { failures: [], errors: [], passed: 0 }]).check)).rejects.toThrow('MUTATION_RESTORE_FAILS');
    const alongside: TestRun = { failures: [...caught.failures, { title: 'another test', message: 'expect(received).toBe(expected)' }], errors: [], passed: 0 };
    await expect(checkBrokenBinding(rig([passing, alongside, passing]).check)).rejects.toThrow('MUTATION_UNRELATED_FAILURES');
  });
});

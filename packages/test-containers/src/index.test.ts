import { describe, expect, it, vi } from 'vitest';
import { ATTEMPT_LABEL, PORT_BOUND_TIMEOUT, START_ATTEMPTS, startWithRetry } from './index.js';

const portBound = (): Error => new Error('Timed out after 30000ms while waiting for container ports to be bound to the host');
const noRemoval = (): Promise<void> => Promise.resolve();

describe('starting a container again', () => {
  it('returns the container of the first attempt that starts, and starts no second one', async () => {
    const start = vi.fn().mockResolvedValue('server');
    expect(await startWithRetry(start, { remove: noRemoval })).toBe('server');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts again after the port-bound timeout, until an attempt starts', async () => {
    const start = vi.fn().mockRejectedValueOnce(portBound()).mockRejectedValueOnce(portBound()).mockResolvedValue('server');
    expect(await startWithRetry(start, { remove: noRemoval })).toBe('server');
    expect(start).toHaveBeenCalledTimes(START_ATTEMPTS);
  });

  it('gives up after three attempts in all and throws the error of the last one', async () => {
    const last = portBound();
    const start = vi.fn().mockRejectedValueOnce(portBound()).mockRejectedValueOnce(portBound()).mockRejectedValueOnce(last);
    await expect(startWithRetry(start, { remove: noRemoval })).rejects.toBe(last);
    expect(start).toHaveBeenCalledTimes(3);
    expect(START_ATTEMPTS).toBe(3);
  });

  it('makes the number of attempts a setting, and one attempt is no retry', async () => {
    const only = portBound();
    const start = vi.fn().mockRejectedValue(only);
    await expect(startWithRetry(start, { attempts: 1, remove: noRemoval })).rejects.toBe(only);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('no such image'), new Error('Timed out after 30000ms while waiting for the container to be ready'), new TypeError('x is not a function'), 'a string that is thrown'])('throws any other error at once, without another attempt: %s', async (failure) => {
    const start = vi.fn().mockRejectedValue(failure);
    await expect(startWithRetry(start, { remove: noRemoval })).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('gives each attempt its own label and removes the containers of a failed attempt before the next one starts', async () => {
    const events: string[] = [];
    const labels: string[] = [];
    const start = vi.fn(async (given: Readonly<Record<string, string>>) => {
      const label = given[ATTEMPT_LABEL];
      if (label === undefined) throw new Error('the attempt has no label');
      labels.push(label);
      events.push(`start ${labels.length}`);
      if (labels.length === 1) throw portBound();
      return 'server';
    });
    const remove = vi.fn(async (label: string) => {
      events.push(`remove ${label}`);
    });
    expect(await startWithRetry(start, { remove })).toBe('server');
    expect(new Set(labels).size).toBe(2);
    expect(events).toEqual(['start 1', `remove ${ATTEMPT_LABEL}=${labels[0]}`, 'start 2']);
  });

  it('removes the containers of an attempt that failed for another reason too, and of the last failed attempt, before it throws', async () => {
    const remove = vi.fn(noRemoval);
    await expect(startWithRetry(vi.fn().mockRejectedValue(new Error('no such image')), { remove })).rejects.toThrow('no such image');
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockClear();
    await expect(startWithRetry(vi.fn().mockRejectedValue(portBound()), { remove })).rejects.toThrow('Timed out');
    expect(remove).toHaveBeenCalledTimes(START_ATTEMPTS);
  });

  it('does not remove anything when the first attempt starts', async () => {
    const remove = vi.fn(noRemoval);
    await startWithRetry(vi.fn().mockResolvedValue('server'), { remove });
    expect(remove).not.toHaveBeenCalled();
  });

  it('starts nothing again when the removal of the failed attempt fails, and throws both errors', async () => {
    const removal = new Error('docker is not answering');
    const failure = portBound();
    const start = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('server');
    await expect(startWithRetry(start, { remove: vi.fn().mockRejectedValue(removal) })).rejects.toMatchObject({ name: 'AggregateError', errors: [failure, removal] });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('throws both errors when the removal fails after an error that is not retried', async () => {
    const removal = new Error('docker is not answering');
    const failure = new Error('no such image');
    await expect(startWithRetry(vi.fn().mockRejectedValue(failure), { remove: vi.fn().mockRejectedValue(removal) })).rejects.toMatchObject({ errors: [failure, removal] });
  });
});

describe('the port-bound timeout', () => {
  it.each(['Timed out after 30000ms while waiting for container ports to be bound to the host', 'Error: Timed out after 5ms while waiting for container ports to be bound'])('is recognised in %s', (message) => {
    expect(PORT_BOUND_TIMEOUT.test(message)).toBe(true);
  });

  it.each(['Timed out after 30000ms while waiting for the container to be ready', 'ports are already allocated', ''])('is not recognised in %s', (message) => {
    expect(PORT_BOUND_TIMEOUT.test(message)).toBe(false);
  });
});

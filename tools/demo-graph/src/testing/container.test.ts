import { describe, expect, it, vi } from 'vitest';
import { startWithRetry } from './container.js';

describe('starting a container again', () => {
  const portBound = () => new Error('Timed out after 30000ms while waiting for container ports to be bound to the host');

  it('starts again after the port-bound timeout and returns the server that started', async () => {
    const start = vi.fn().mockRejectedValueOnce(portBound()).mockResolvedValueOnce('server');
    expect(await startWithRetry(start)).toBe('server');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts and throws the last timeout itself', async () => {
    const last = portBound();
    const start = vi.fn().mockRejectedValueOnce(portBound()).mockRejectedValueOnce(portBound()).mockRejectedValueOnce(last).mockRejectedValue(portBound());
    await expect(startWithRetry(start)).rejects.toBe(last);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('makes a single attempt when told to', async () => {
    const only = portBound();
    const start = vi.fn().mockRejectedValue(only);
    await expect(startWithRetry(start, 1)).rejects.toBe(only);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('image not found'), new Error('Timed out after 240000ms while waiting for container to be ready'), 'not an error'])(
    'throws any other failure at once: %s',
    async (failure) => {
      const start = vi.fn().mockRejectedValue(failure);
      await expect(startWithRetry(start)).rejects.toBe(failure);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );
});

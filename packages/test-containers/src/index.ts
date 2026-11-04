import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * testcontainers 12.2.1 waits a fixed 30 s for the host port to be bound and offers no setting for it, so
 * `withStartupTimeout` cannot cover that wait. Docker here binds a port in about 0.15 s, so a timeout is a rare
 * stall of the Docker daemon and a new attempt succeeds.
 */
export const START_ATTEMPTS = 3;
export const PORT_BOUND_TIMEOUT = /Timed out after \d+ms while waiting for container ports to be bound/;
export const ATTEMPT_LABEL = 'neburyx.start-attempt';

/** Removes every container that has the label (`name=value`), running or not. */
export type RemoveContainers = (label: string) => Promise<void>;

export interface StartOptions {
  readonly attempts?: number;
  readonly remove?: RemoveContainers;
}

export const removeLabelled: RemoveContainers = async (label) => {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=${label}`]);
  const ids = stdout.split('\n').filter((id) => id !== '');
  if (ids.length > 0) await run('docker', ['rm', '-f', ...ids]);
};

/**
 * Starts a container and starts again only when the port-bound wait timed out, up to `attempts` in all; every other error is
 * thrown at once. The start is given a label for its attempt, which it must put on the container, and the containers of a
 * failed attempt are removed before the next one or before the error is thrown, so that a failed attempt keeps no host port.
 * When that removal fails, nothing starts again, because the failed container may still hold its port, and both errors are thrown.
 */
export async function startWithRetry<T>(start: (labels: Readonly<Record<string, string>>) => Promise<T>, options: StartOptions = {}): Promise<T> {
  const { attempts = START_ATTEMPTS, remove = removeLabelled } = options;
  for (let attempt = 1; ; attempt += 1) {
    const value = randomUUID();
    try {
      return await start({ [ATTEMPT_LABEL]: value });
    } catch (error) {
      try {
        await remove(`${ATTEMPT_LABEL}=${value}`);
      } catch (removal) {
        throw new AggregateError([error, removal], 'a container failed to start and its removal failed');
      }
      if (attempt >= attempts || !(error instanceof Error) || !PORT_BOUND_TIMEOUT.test(error.message)) throw error;
    }
  }
}

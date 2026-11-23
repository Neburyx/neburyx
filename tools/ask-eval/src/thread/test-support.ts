import type { SpawnOptions } from 'node:child_process';
import type { EvalHooks } from '../hooks.js';
import type { Spawn } from './scorer.js';

/** The element at an index of a list the test knows holds it; a missing one fails the test loudly instead of passing `undefined` on. */
export function nth<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`the list has no element ${index}`);
  return found;
}

/** The thread commands never use the hooks the other commands need, so the tests give them an empty stand-in; the assertion is the one place a test pretends to have them. */
export const noHooks: EvalHooks = {} as unknown as EvalHooks;

/** What a stand-in child process does: the text it prints, the text it prints as an error and the code it exits with. */
interface Behaviour {
  readonly out?: string;
  readonly err?: string;
  readonly code: number;
}

/** A `spawn` whose child prints and exits as the behaviour says; the assertion narrows a stand-in that has only the members the runners read to the type the runners take. */
export function stubSpawn(behave: (command: string, args: readonly string[], options: SpawnOptions) => Behaviour): Spawn {
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    const result = behave(command, args, options);
    return {
      stdin: { end: () => undefined },
      stdout: { on: (_event: string, listener: (chunk: Buffer) => void) => void setTimeout(() => listener(Buffer.from(result.out ?? '')), 0) },
      stderr: { on: (_event: string, listener: (chunk: Buffer) => void) => void setTimeout(() => listener(Buffer.from(result.err ?? '')), 0) },
      on: (event: string, listener: (value?: number) => void) => {
        if (event === 'close') setTimeout(() => listener(result.code), 5);
      },
    };
  };
  return spawn as unknown as Spawn;
}

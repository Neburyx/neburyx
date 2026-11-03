import { describe, expect, it } from 'vitest';
import { dockerOk } from '../image/docker.js';
import { destroyAll, Stack } from './stack.js';

async function containersOf(stack: Stack): Promise<string> {
  return dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`]);
}

describe('removing several stacks', () => {
  it('removes every stack when one of them fails to be removed, and reports the failure', async () => {
    const stacks = await Promise.all([1, 2, 3].map(() => Stack.create({ image: 'neburyx-destroy-all-test', tag: 'none' })));
    try {
      for (const stack of stacks) {
        const created = await stack.compose(['up', '--no-start', 'db']);
        expect(created.code, created.stderr).toBe(0);
        expect(await containersOf(stack)).not.toBe('');
      }
      const [first, second, third] = stacks;
      if (first === undefined || second === undefined || third === undefined) throw new Error('three stacks expected');
      const failing = {
        destroy: async () => {
          await second.destroy();
          throw new Error('this stack could not be removed');
        },
      };

      const failure: unknown = await destroyAll([first, failing, third]).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure instanceof AggregateError ? failure.errors.map(String) : []).toEqual(['Error: this stack could not be removed']);
      for (const stack of stacks) expect(await containersOf(stack), stack.project).toBe('');
      expect(await dockerOk(['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'])).not.toContain(first.project);
    } finally {
      await destroyAll(stacks);
    }
  });
});

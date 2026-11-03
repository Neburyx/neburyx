// A separate process that tries to take the lock and says whether it did. It waits for a start file so that contenders begin together.
import { existsSync } from 'node:fs';
import { Lock, LockHeld } from '../lock.ts';

const [folder, repository, startFile, holdMs] = process.argv.slice(2);
while (!existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 1));
try {
  Lock.acquire({ folder, repository });
  process.stdout.write('acquired\n');
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
} catch (error) {
  process.stdout.write(error instanceof LockHeld ? 'refused\n' : `failed ${String(error)}\n`);
}

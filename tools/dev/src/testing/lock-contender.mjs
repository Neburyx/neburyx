import { existsSync } from 'node:fs';
import { Lock, LockHeld } from '../lock.ts';

const [folder, repository, startFile, releaseFile] = process.argv.slice(2);
process.stdout.write('ready\n');
while (!existsSync(startFile)) await new Promise((resolve) => setTimeout(resolve, 1));
let outcome = 'refused';
try {
  Lock.acquire({ folder, repository });
  outcome = 'acquired';
} catch (error) {
  outcome = error instanceof LockHeld ? 'refused' : `failed ${String(error)}`;
}
process.stdout.write(`${outcome}\n`);
while (!existsSync(releaseFile)) await new Promise((resolve) => setTimeout(resolve, 5));

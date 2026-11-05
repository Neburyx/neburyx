import { checkDevServer } from './server.js';

/**
 * The check of the dev server as a program, for a vitest run to start before its tests: the driver cannot run in the main process of vitest, whose handling of
 * stack traces fails inside it, so the check runs in a process of its own. It prints the version of the server, or says what is wrong and ends with 1.
 */
try {
  process.stdout.write(`${await checkDevServer()}\n`);
} catch (error) {
  const messages = error instanceof AggregateError ? error.errors.map((entry) => (entry instanceof Error ? entry.message : 'an error')) : [error instanceof Error ? error.message : 'an error'];
  process.stderr.write(`${messages.join('\n')}\n`);
  process.exitCode = 1;
}

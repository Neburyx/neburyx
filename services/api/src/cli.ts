import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE } from './commands.js';
import { runMigrateCommand } from './migrate/command.js';
import { createInterface } from 'node:readline/promises';
import { runSourceRebindCommand } from './source-rebind/command.js';
import { runTestSourceCommand } from './source-test/command.js';

const command = parseCommand(process.argv.slice(2));

if (command === 'migrate') {
  const code = await runMigrateCommand(process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
    directory: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  process.exit(code);
}

if (command === 'test-source') {
  const code = await runTestSourceCommand(process.argv.slice(3), process.env, { stdout: process.stdout, stderr: process.stderr });
  process.exit(code);
}

if (command === 'source') {
  const ask = process.stdin.isTTY
    ? async (question: string): Promise<string> => {
        const lines = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await lines.question(question);
        } finally {
          lines.close();
        }
      }
    : undefined;
  const code = await runSourceRebindCommand(process.argv.slice(3), process.env, { stdout: process.stdout, stderr: process.stderr, ...(ask === undefined ? {} : { ask }) });
  process.exit(code);
}

if (command === 'api') {
  await import('./main.js');
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}

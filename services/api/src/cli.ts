import { fileURLToPath } from 'node:url';
import { parseCommand, USAGE } from './commands.js';
import { runMigrateCommand } from './migrate/command.js';

const command = parseCommand(process.argv.slice(2));

if (command === 'migrate') {
  const code = await runMigrateCommand(process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
    directory: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  process.exit(code);
}

if (command === 'api') {
  await import('./main.js');
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}

import { fileURLToPath } from 'node:url';
import { runMigrateCommand } from './migrate/command.js';

const [command] = process.argv.slice(2);

if (command === 'migrate') {
  const code = await runMigrateCommand(process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
    directory: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  process.exit(code);
}

process.stderr.write('usage: neburyx migrate\n');
process.exit(2);

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const { EXIT_AFTER_MS, LOG_FILE, NAME, GRANDCHILD, IGNORE_TERM } = process.env;
appendFileSync(LOG_FILE, `${NAME} ${process.pid}\n`);
if (IGNORE_TERM === '1') process.on('SIGTERM', () => undefined);
if (GRANDCHILD === '1') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
  appendFileSync(LOG_FILE, `grandchild ${grandchild.pid}\n`);
}
if (EXIT_AFTER_MS !== undefined) setTimeout(() => process.exit(2), Number(EXIT_AFTER_MS));
setInterval(() => undefined, 1000);

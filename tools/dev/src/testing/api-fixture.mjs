import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { PORT, START_DELAY_MS = '0', EXIT_AFTER_MS, EXIT_CODE = '3', LOG_FILE, NEVER_LISTEN, FAIL_AT_START, LINGERING_HELPER } = process.env;
appendFileSync(LOG_FILE, `start ${process.pid}\n`);
if (FAIL_AT_START === '1') process.exit(1);
if (LINGERING_HELPER === '1') {
  // logs "helper <pid>" only once its SIGTERM handler is installed, so a test can wait for it
  const code = "const { appendFileSync } = require('node:fs'); process.on('SIGTERM', () => undefined); appendFileSync(process.env.LOG_FILE, `helper ${process.pid}\\n`); setInterval(() => undefined, 1000)";
  spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
}
if (NEVER_LISTEN !== '1') {
  setTimeout(() => {
    createServer((request, response) => {
      response.statusCode = request.url === '/healthz' ? 200 : 404;
      response.end('ok');
    }).listen(Number(PORT), '127.0.0.1');
    if (EXIT_AFTER_MS !== undefined) setTimeout(() => process.exit(Number(EXIT_CODE)), Number(EXIT_AFTER_MS));
  }, Number(START_DELAY_MS));
} else {
  setInterval(() => undefined, 1000);
}

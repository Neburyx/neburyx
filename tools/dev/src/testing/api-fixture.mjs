import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const { PORT, START_DELAY_MS = '0', EXIT_AFTER_MS, EXIT_CODE = '3', LOG_FILE, NEVER_LISTEN, FAIL_AT_START } = process.env;
appendFileSync(LOG_FILE, `start ${process.pid}\n`);
if (FAIL_AT_START === '1') process.exit(1);
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

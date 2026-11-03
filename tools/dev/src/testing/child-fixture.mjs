// A stand-in for a compiler or the web server: runs until it is stopped, or exits by itself after EXIT_AFTER_MS.
import { appendFileSync } from 'node:fs';

const { EXIT_AFTER_MS, LOG_FILE, NAME } = process.env;
appendFileSync(LOG_FILE, `${NAME} ${process.pid}\n`);
if (EXIT_AFTER_MS !== undefined) setTimeout(() => process.exit(2), Number(EXIT_AFTER_MS));
setInterval(() => undefined, 1000);

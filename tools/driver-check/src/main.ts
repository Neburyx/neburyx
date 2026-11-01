import { writeAll } from './io.js';
import { parseArgs, realDeps, runCheck, USAGE } from './run.js';

const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  await writeAll(process.stderr, `${parsed.error}\n${USAGE}\n`);
  process.exit(1);
}

const pending: Promise<void>[] = [];
const code = await runCheck(
  parsed.images,
  {
    out: (text) => void pending.push(writeAll(process.stdout, `${text}\n`)),
    err: (text) => void pending.push(writeAll(process.stderr, `${text}\n`)),
  },
  realDeps,
);
await Promise.all(pending);
process.exit(code);

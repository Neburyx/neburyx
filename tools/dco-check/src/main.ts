import { run } from './run.js';

process.exitCode = run(process.argv.slice(2), process.cwd(), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2), {
  out: (text) => void process.stdout.write(`${text}\n`),
  err: (text) => void process.stderr.write(`${text}\n`),
  env: process.env,
});
process.exitCode = code;

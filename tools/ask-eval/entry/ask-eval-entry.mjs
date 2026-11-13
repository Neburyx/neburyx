import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { runCli } from '../dist/cli.js';

process.exitCode = await runCli(
  process.argv.slice(2),
  { out: (line) => void process.stdout.write(`${line}\n`), err: (line) => void process.stderr.write(`${line}\n`) },
  { createEvalPlanner },
);

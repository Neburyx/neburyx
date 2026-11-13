import { readFileSync } from 'node:fs';
import { runQuestionWordsCommand } from '../dist/allowlist/index.js';

process.exitCode = runQuestionWordsCommand(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readText: (path) => readFileSync(path, 'utf8'),
});

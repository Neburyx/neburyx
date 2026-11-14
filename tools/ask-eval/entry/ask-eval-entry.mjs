import { classify, liveProvider, loadSource, plannedSettings, recordingProvider, replayProvider } from '@neburyx/ee-ask/eval';
import { runCli } from '../dist/cli.js';

const hooks = { loadSource, classify, replayProvider, recordingProvider, plannedSettings, liveProvider };

process.exitCode = await runCli(
  process.argv.slice(2),
  { out: (line) => void process.stdout.write(`${line}\n`), err: (line) => void process.stderr.write(`${line}\n`), env: process.env },
  hooks,
);

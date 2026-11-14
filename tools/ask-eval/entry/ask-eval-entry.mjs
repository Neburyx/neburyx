import { createLedger, createRecorder } from '../../../ee/ask/dist/eval/record.js';
import { liveProvider } from '../../../ee/ask/dist/eval/live-provider.js';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { runCli } from '../dist/cli.js';
import { loadAiFile, loadAiSettings, loadMapping } from '../dist/mapping-view.js';

const recording = {
  createLedger,
  createRecorder,
  provider: ({ mapping, ai, model }) => liveProvider({ settings: ai === undefined ? loadAiSettings(mapping) : loadAiFile(ai), view: loadMapping(mapping).view, model, env: process.env }),
};

process.exitCode = await runCli(
  process.argv.slice(2),
  { out: (line) => void process.stdout.write(`${line}\n`), err: (line) => void process.stderr.write(`${line}\n`) },
  { createEvalPlanner, recording },
);

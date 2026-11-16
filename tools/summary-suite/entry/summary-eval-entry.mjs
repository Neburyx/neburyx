import { budgetedProvider, evalSummarizer, liveSummaryProvider, scriptedSummaryProvider, summaryRunSettings } from '@neburyx/ee-ask/eval';
import { runCli } from '../dist/eval/cli.js';

const hooks = {
  settings: (env) => summaryRunSettings(env),
  scriptedProvider: (replyFor) => scriptedSummaryProvider(replyFor),
  liveProvider: (env, folder, settings) => liveSummaryProvider(env, folder, settings),
  budgeted: (inner, budget, onRequest) => budgetedProvider(inner, budget, onRequest),
  summarizer: (options) => evalSummarizer(options),
};

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

process.exitCode = await runCli(
  process.argv.slice(2),
  { out: (line) => void process.stdout.write(`${line}\n`), err: (line) => void process.stderr.write(`${line}\n`), env: process.env, signal: controller.signal },
  hooks,
);

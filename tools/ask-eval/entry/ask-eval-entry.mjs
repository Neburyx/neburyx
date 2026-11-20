import { assistantLimits, assistantRunSettings, classify, contextKeys, contextTurns, liveAssistantProvider, liveProvider, loadSource, loopCostRun, loopDefaults, routeMessage, routerRequests, routerTextBytes, routerTextSha256, runSettings, recordingProvider, replayProvider } from '@neburyx/ee-ask/eval';
import { runCli } from '../dist/cli.js';

const hooks = { loadSource, classify, replayProvider, recordingProvider, runSettings, liveProvider, routeMessage, routerRequests, routerTextBytes, routerTextSha256, contextKeys, contextTurns, assistantRunSettings, liveAssistantProvider, loopCostRun, loopDefaults, assistantLimits };

process.exitCode = await runCli(
  process.argv.slice(2),
  { out: (line) => void process.stdout.write(`${line}\n`), err: (line) => void process.stderr.write(`${line}\n`), env: process.env },
  hooks,
);

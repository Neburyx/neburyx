import { resolve } from 'node:path';
import { AdapterError } from '../adapter.js';
import { FixtureError } from '../fixture/errors.js';
import { MeasureError } from '../measure/errors.js';
import { RunnerError } from './errors.js';
import { runSpike, type RunnerDeps } from './run.js';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new RunnerError('USAGE', `${name} needs a value`);
  return value;
}

export function describeFailure(error: unknown): string {
  if (error instanceof RunnerError) return error.message;
  if (error instanceof MeasureError || error instanceof AdapterError || error instanceof FixtureError) return error.code;
  return 'UNEXPECTED_ERROR';
}

/** Returns the exit code: 0 when a complete report was written, 1 otherwise. */
export async function runCli(args: readonly string[], deps: RunnerDeps, io: CliIo): Promise<number> {
  try {
    const adapter = readOption(args, '--adapter');
    const out = readOption(args, '--out');
    if (adapter === undefined || out === undefined) throw new RunnerError('USAGE', 'run with --adapter <name> --out <report.json> [--screenshots <dir>] [--cpu-throttle <n>]');
    const screenshots = readOption(args, '--screenshots');
    const throttle = readOption(args, '--cpu-throttle');
    const report = await runSpike({ adapter, out: resolve(out), ...(screenshots === undefined ? {} : { screenshots: resolve(screenshots) }), ...(throttle === undefined ? {} : { cpuThrottle: Number(throttle) }) }, deps);
    const { manual, pinned, unpinned, frames } = report.incremental;
    io.out(`${report.adapter.name} at ${report.protocol.cpuThrottle}x CPU: ${report.runs.map((run) => `${run.medianFps.toFixed(1)} fps median, ${run.p5Fps.toFixed(1)} fps p5`).join('; ')}\n`);
    io.out(`grouping ${report.grouping.typeId}: ${report.grouping.supported ? `${report.grouping.members} members, restored ${report.grouping.restored}` : 'unsupported'}\n`);
    io.out(`keyboard: wraps ${report.keyboard.wrapsFromLast}, ignored without focus ${report.keyboard.ignoredWithoutFocus}, ring visible on ${report.keyboard.steps.filter((step) => step.ringVisible).length} of ${report.keyboard.steps.length} steps\n`);
    io.out(`moved after ${report.incremental.addedNodes} added: manual ${manual.moved}/${manual.total}, pinned ${pinned.moved}/${pinned.total}, unpinned ${unpinned.moved}/${unpinned.total} (median ${unpinned.medianDisplacement.toFixed(1)}, max ${unpinned.maxDisplacement.toFixed(1)}); add took ${report.incremental.addDurationMs.toFixed(0)} ms, longest frame ${report.incremental.longestFrameMs.toFixed(0)} ms, then ${frames.medianFps.toFixed(1)} fps median\n`);
    return 0;
  } catch (error) {
    io.err(`${describeFailure(error)}\n`);
    return 1;
  }
}

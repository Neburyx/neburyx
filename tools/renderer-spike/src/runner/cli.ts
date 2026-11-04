import { resolve } from 'node:path';
import { AdapterError } from '../adapter.js';
import { FixtureError } from '../fixture/errors.js';
import { MeasureError } from '../measure/errors.js';
import { RunnerError } from './errors.js';
import { runAddBenchmark } from '../product/add-run.js';
import { runLayoutBenchmark } from '../product/layout-run.js';
import { runProductBenchmark, type ProductDeps } from '../product/run.js';
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

async function runProduct(args: readonly string[], deps: ProductDeps | undefined, io: CliIo): Promise<number> {
  const url = readOption(args, '--url');
  const out = readOption(args, '--out');
  if (deps === undefined || url === undefined || out === undefined) throw new RunnerError('USAGE', 'run with --target product --url <app address> --out <report.json> [--scenario pan-zoom|add|layout] [--cpu-throttle <n>]');
  const throttle = readOption(args, '--cpu-throttle');
  const scenario = readOption(args, '--scenario') ?? 'pan-zoom';
  if (scenario !== 'pan-zoom' && scenario !== 'add' && scenario !== 'layout') throw new RunnerError('USAGE', `--scenario takes pan-zoom, add or layout, not ${scenario}`);
  if (scenario === 'layout') {
    const laid = await runLayoutBenchmark({ url, out: resolve(out), ...(throttle === undefined ? {} : { cpuThrottle: Number(throttle) }) }, deps);
    io.out(`laying out the product canvas, ${laid.app.drawnEntities} entities and ${laid.app.drawnRelationships} relationships drawn, at ${laid.protocol.cpuThrottle}x CPU: ${laid.runs.map((run) => `${run.movedUnpinned} unpinned moved, the command took ${run.commandMs.toFixed(0)} ms, longest frame ${run.longestFrameMs.toFixed(0)} ms, ${run.p5Fps.toFixed(1)} fps p5 over ${run.frames} frames`).join('; ')}\n`);
    io.out(`target (at ${laid.goal.cpuThrottle}x: no frame longer than ${laid.goal.longestFrameMs} ms, 5th percentile at least ${laid.goal.p5Fps} fps over the next 30 frames): ${laid.verdict}\n`);
    return 0;
  }
  if (scenario === 'add') {
    const added = await runAddBenchmark({ url, out: resolve(out), ...(throttle === undefined ? {} : { cpuThrottle: Number(throttle) }) }, deps);
    io.out(`adding entities to the product canvas, ${added.app.drawnEntities} entities and ${added.app.drawnRelationships} relationships drawn, at ${added.protocol.cpuThrottle}x CPU: ${added.runs.map((run) => `+${run.addedEntities} entities, longest frame ${run.longestFrameMs.toFixed(0)} ms, ${run.p5Fps.toFixed(1)} fps p5 over ${run.frames} frames, moved ${run.movedUnpinned + run.movedPinned}`).join('; ')}\n`);
    io.out(`target (at ${added.goal.cpuThrottle}x: no frame longer than ${added.goal.longestFrameMs} ms, 5th percentile at least ${added.goal.p5Fps} fps over the next 30 frames): ${added.verdict}\n`);
    return 0;
  }
  const report = await runProductBenchmark({ url, out: resolve(out), ...(throttle === undefined ? {} : { cpuThrottle: Number(throttle) }) }, deps);
  io.out(`the product canvas, ${report.app.drawnEntities} entities and ${report.app.drawnRelationships} relationships drawn, at ${report.protocol.cpuThrottle}x CPU: ${report.runs.map((run) => `${run.medianFps.toFixed(1)} fps median, ${run.p5Fps.toFixed(1)} fps p5`).join('; ')}\n`);
  io.out(`target (at ${report.goal.cpuThrottle}x: median at least ${report.goal.medianFps} fps, 5th percentile at least ${report.goal.p5Fps} fps): ${report.verdict}\n`);
  return 0;
}

/** Returns the exit code: 0 when a complete report was written, 1 otherwise. */
export async function runCli(args: readonly string[], deps: RunnerDeps, io: CliIo, productDeps?: ProductDeps): Promise<number> {
  try {
    const target = readOption(args, '--target');
    if (target === 'product') return await runProduct(args, productDeps, io);
    if (target !== undefined) throw new RunnerError('USAGE', `--target takes product, not ${target}`);
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

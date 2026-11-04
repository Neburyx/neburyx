import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MeasureError } from './errors.js';
import { incrementalResultSchema } from './incremental.js';
import { groupingResultSchema, keyboardResultSchema } from './probes.js';

const runSchema = z.strictObject({ frames: z.number().int().positive(), medianFps: z.number().positive(), p5Fps: z.number().positive() });

export const reportSchema = z.strictObject({
  status: z.literal('complete'),
  measuredAt: z.iso.datetime(),
  adapter: z.strictObject({ name: z.string().min(1), versions: z.record(z.string(), z.string()) }),
  browser: z.strictObject({ name: z.string().min(1), version: z.string().min(1), headed: z.boolean() }),
  os: z.strictObject({ platform: z.string().min(1), release: z.string().min(1), arch: z.string().min(1) }),
  cpu: z.strictObject({ model: z.string().min(1), cores: z.number().int().positive() }),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), devicePixelRatio: z.number().positive() }),
  protocol: z.strictObject({ runDurationMs: z.number().int().positive(), runs: z.number().int().positive(), cpuThrottle: z.number().int().min(1) }),
  runs: z.array(runSchema).min(1),
  grouping: groupingResultSchema,
  keyboard: keyboardResultSchema,
  incremental: incrementalResultSchema,
});

export type Report = z.infer<typeof reportSchema>;

/** Writes the text to a temporary file and moves it into place, so the file appears all at once or not at all. */
export function writeFileOnce(path: string, text: string): void {
  const temporary = `${path}.partial`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // the write error below is the one worth reporting; a failed cleanup must not replace it
    }
    throw new MeasureError('REPORT_WRITE_FAILED');
  }
}

/** Writes the report only if it is complete. */
export function writeReport(path: string, report: unknown): Report {
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) throw new MeasureError('REPORT_INVALID');
  writeFileOnce(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

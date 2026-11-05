import { z } from 'zod';
import { MeasureError } from '../measure/errors.js';
import { writeFileOnce } from '../measure/report.js';
import { TARGET } from './target.js';

const runSchema = z.strictObject({
  frames: z.number().int().positive(),
  medianFps: z.number().positive(),
  p5Fps: z.number().positive(),
  /** The largest zoom seen over the smallest during the run, and the pan the drags alone moved, in pixels. */
  zoomRatio: z.number().positive(),
  panTravel: z.number().nonnegative(),
});

export const productReportSchema = z.strictObject({
  status: z.literal('complete'),
  target: z.literal('product'),
  measuredAt: z.iso.datetime(),
  app: z.strictObject({ origin: z.string().min(1), drawnEntities: z.number().int().positive(), drawnRelationships: z.number().int().positive(), zoom: z.number().positive() }),
  browser: z.strictObject({ name: z.string().min(1), version: z.string().min(1), headed: z.boolean() }),
  os: z.strictObject({ platform: z.string().min(1), release: z.string().min(1), arch: z.string().min(1) }),
  cpu: z.strictObject({ model: z.string().min(1), cores: z.number().int().positive() }),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), devicePixelRatio: z.number().positive() }),
  protocol: z.strictObject({ runDurationMs: z.number().int().positive(), runs: z.number().int().positive(), cpuThrottle: z.number().int().min(1) }),
  runs: z.array(runSchema).min(1),
  goal: z.strictObject({ cpuThrottle: z.literal(TARGET.cpuThrottle), medianFps: z.literal(TARGET.medianFps), p5Fps: z.literal(TARGET.p5Fps) }),
  verdict: z.enum(['met', 'not-met', 'not-applicable']),
});

export type ProductReport = z.infer<typeof productReportSchema>;

/** Writes the report only if it is complete; the file appears all at once or not at all. */
export function writeProductReport(path: string, report: unknown): ProductReport {
  const parsed = productReportSchema.safeParse(report);
  if (!parsed.success) throw new MeasureError('REPORT_INVALID');
  writeFileOnce(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

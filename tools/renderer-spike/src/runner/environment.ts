import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Report } from '../measure/report.js';

const packageSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

export function adapterVersions(root: string, adapter: string, packages: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const file of packages[adapter] ?? []) {
    const parsed = packageSchema.safeParse(JSON.parse(readFileSync(join(root, file), 'utf8')));
    if (parsed.success) versions[parsed.data.name] = parsed.data.version;
  }
  return versions;
}

export function machine(): Pick<Report, 'os' | 'cpu'> {
  const processors = cpus();
  return { os: { platform: platform(), release: release(), arch: arch() }, cpu: { model: processors[0]?.model ?? 'unknown', cores: Math.max(processors.length, 1) } };
}

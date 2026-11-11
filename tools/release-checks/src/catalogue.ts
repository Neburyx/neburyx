import { BUILD_FIRST } from './build-first.js';
import { commandCheck } from './command-check.js';
import { neutralityCheck } from './neutrality.js';
import { demoInstallCheck } from './demo-install.js';
import { fuzzRealServerCheck, supernodeSuiteCheck } from './supernode.js';
import type { Check } from './types.js';

export function fuzzCheck(repoRoot: string): Check {
  return commandCheck({
    id: 'fuzz',
    name: 'Input fuzz and cursor-tamper suite',
    requests: [
      { ...BUILD_FIRST, cwd: repoRoot },
      { command: 'pnpm', args: ['--filter', '@neburyx/api', 'exec', 'vitest', 'run', 'src/fuzz'], cwd: repoRoot },
    ],
    expectsTests: true,
  });
}

export const CHECK_IDS = ['fuzz', 'neutrality', 'supernode-suite', 'fuzz-real-server', 'demo-install'] as const;

export function releaseCatalogue(repoRoot: string, image?: string): readonly Check[] {
  return [fuzzCheck(repoRoot), neutralityCheck(), supernodeSuiteCheck(), fuzzRealServerCheck(repoRoot), demoInstallCheck(image === undefined ? {} : { image })];
}

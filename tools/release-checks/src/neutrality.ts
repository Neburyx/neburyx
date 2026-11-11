import { BUILD_FIRST } from './build-first.js';
import { packNames } from './packs.js';
import { describeCommand, execFailure } from './command-check.js';
import { dockerReachable, runVitest, type VitestRun, type VitestRunResult } from './vitest-run.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest } from './types.js';

/** The packages the tests import, then the API itself: the Postgres cases run its `migrate` command from the build. */
const PREPARE: readonly ExecRequest[] = [BUILD_FIRST, { command: 'pnpm', args: ['--filter', '@neburyx/api', 'build'] }];

const SAVED_VIEW_OUTCOMES = ['placeholders at the saved places', 'the dropped-filter notice', 'no error'] as const;

const COMPOSE_SUITE_IMAGE_PREFIX = 'neburyx-demo-test:';

export interface Part {
  readonly id: string;
  readonly runs: readonly VitestRun[];
}

export function neutralityParts(packCount: number): readonly Part[] {
  return [
    { id: 'domains', runs: [{ label: 'domains', package: '@neburyx/workspace-checks', args: ['src/domain-words'], needsDocker: false, required: [{ title: 'holds no pack identifier as a string literal in the product directories', atLeast: 1 }] }] },
    { id: 'packs', runs: [{ label: 'packs', package: '@neburyx/api', args: ['src/packs.test.ts'], needsDocker: false, required: [] }] },
    {
      id: 'demo-compose',
      runs: [
        {
          label: 'demo-compose',
          package: '@neburyx/api',
          args: ['--config', 'vitest.compose.config.ts', 'src/compose/demo.compose.test.ts'],
          needsDocker: true,
          required: [
            { title: 'passes, prints the read-only line as not verified', atLeast: packCount },
            { title: 'fails and names the entity type and its stable ID property when the stable ID constraint is dropped', atLeast: packCount },
          ],
        },
      ],
    },
    {
      id: 'saved-view',
      runs: [
        { label: 'saved-view-memory', package: '@neburyx/save-suite', args: ['src/mapping-change.test.ts'], needsDocker: false, required: [{ title: 'shows a placeholder at the saved place for each unmapped item', atLeast: 1 }] },
        {
          label: 'saved-view-postgres',
          package: '@neburyx/save-suite',
          args: ['--config', 'vitest.integration.config.ts', 'src/pg-mapping.integration.test.ts'],
          needsDocker: true,
          required: [{ title: 'shows the placeholders and the dropped-filter notice with no error', atLeast: 1 }],
        },
      ],
    },
  ];
}

interface PartResult {
  readonly id: string;
  readonly status: 'passed' | 'failed';
  readonly detail: string;
  readonly runs: readonly VitestRunResult[];
}

function summarize(id: string, runs: readonly VitestRunResult[]): PartResult {
  const failed = runs.filter((run) => run.status === 'failed');
  return { id, status: failed.length === 0 ? 'passed' : 'failed', detail: failed.length === 0 ? runs.map((run) => run.detail).join('; ') : failed.map((run) => `${run.label}: ${run.detail}`).join('; '), runs };
}

async function findSuiteImage(context: CheckContext, sinceSeconds: number, untilSeconds: number): Promise<{ readonly tag: string; readonly id: string } | undefined> {
  const result = await context.exec({
    command: 'docker',
    args: ['events', '--since', String(sinceSeconds), '--until', String(untilSeconds), '--filter', 'type=image', '--filter', 'event=tag', '--filter', 'event=untag', '--format', '{{json .}}'],
    cwd: context.repoRoot,
  });
  if (result.exitCode !== 0) return undefined;
  for (const line of result.output.split('\n')) {
    const found = /"ID":"(sha256:[0-9a-f]+)".*"name":"(neburyx-demo-test:[^"]+)"/.exec(line);
    if (found?.[1] !== undefined && found[2]?.startsWith(COMPOSE_SUITE_IMAGE_PREFIX) === true) return { id: found[1], tag: found[2] };
  }
  return undefined;
}

export function neutralityCheck(now: () => Date = () => new Date()): Check {
  const command = 'neutrality: domains, packs, demo-compose, saved-view';
  return {
    id: 'neutrality',
    name: 'Domain neutrality on both packs',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const packs = packNames(context.repoRoot);
      const outputs: string[] = [];
      const fail = (detail: string, data?: unknown): CheckOutcome => ({ status: 'failed', detail, command, exitCode: null, output: outputs.join(''), data });
      if (packs.length === 0) return fail('no domain packs found');
      for (const prep of PREPARE) {
        const built = await context.exec({ ...prep, cwd: context.repoRoot });
        outputs.push(`$ ${describeCommand(prep)}\n${built.output}`);
        const buildFailure = execFailure(built, undefined);
        if (buildFailure !== undefined) return fail(`build: ${buildFailure}`, { packs });
      }
      const dockerUp = await dockerReachable(context);
      const started = Math.floor(now().getTime() / 1000);
      const parts: PartResult[] = [];
      let composeRan = false;
      let suiteImage: { readonly tag: string; readonly id: string } | undefined;
      for (const part of neutralityParts(packs.length)) {
        const runs: VitestRunResult[] = [];
        for (const run of part.runs) {
          const result = await runVitest(context, run, dockerUp);
          outputs.push(`\n== ${run.label}: ${result.status}: ${result.detail}\n$ ${result.command}\n${result.output}`);
          runs.push(result);
        }
        parts.push(summarize(part.id, runs));
        if (part.id === 'demo-compose' && runs.every((run) => run.exitCode !== null)) {
          composeRan = true;
          // Read straight away: Docker keeps only the latest events. The build is not always announced as a tag, but the suite's removal of its image is an untag event that names the image.
          suiteImage = await findSuiteImage(context, started, Math.ceil(now().getTime() / 1000) + 1);
        }
      }
      const failed = parts.filter((part) => part.status === 'failed');
      const data = {
        packs,
        parts: parts.map((part) => ({ id: part.id, status: part.status, detail: part.detail })),
        savedViewAsserts: SAVED_VIEW_OUTCOMES,
        suiteImage: suiteImage ?? null,
        note: 'The suite image is built by the compose suite for itself and is not the image under test of the demo-install check.',
      };
      const missingImage = composeRan && suiteImage === undefined;
      if (failed.length === 0 && !missingImage) return { status: 'passed', detail: `${parts.length} parts passed over ${packs.join(', ')}`, command, exitCode: 0, output: outputs.join(''), data };
      const reasons = [...failed.map((part) => `${part.id}: ${part.detail}`), ...(missingImage ? ['suite image not found in Docker events'] : [])];
      return { status: 'failed', detail: `failed: ${reasons.join(' | ')}`, command, exitCode: 1, output: outputs.join(''), data };
    },
  };
}

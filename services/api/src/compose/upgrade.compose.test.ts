/**
 * An operator who upgrades changes the image tag in their own compose file and brings the stack up again. This file
 * proves that the build under test does that to a database the previous published image made: the saved work is
 * kept, the migrations the previous image did not have are applied, and the previous image can be put back.
 *
 * It does nothing unless `NEBURYX_UPGRADE_FROM` names the previous image (a full reference with a tag, for example
 * `ghcr.io/neburyx/neburyx:0.1.0`), so a push never pulls an image; it is run once per release. The demo stack runs
 * both images because it is the stack with a source and a graph, which saving an investigation needs.
 * `NEBURYX_UPGRADE_RECORD_DIR` (a folder outside the repository) makes the run write a record of what it proved.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { planImages } from './image-plan.js';
import { buildDerivedImage, DEMO_WAIT_SECONDS, demoComposeFile, destroyAll, repository, Stack } from './stack.js';
import { dirtyTreeRefusal, recordFolder, renderRecord, withExpected, writeRecord, type UpgradeCheck } from './upgrade-record.js';
import { compareRestoredView, compareSavedWork, digestOf, splitReference, type Read, type SavedWork } from './upgrade-saved-work.js';

const FROM = process.env['NEBURYX_UPGRADE_FROM'];
const ownTag = `u-${randomBytes(3).toString('hex')}`;
const images = planImages(process.env, { image: 'neburyx-upgrade-test', tag: ownTag, loader: `neburyx-upgrade-loader-test:${ownTag}` });
const IMAGE = images.image;
const TAG = images.tag;
const LOADER_IMAGE = images.loader;
const TAG_PREVIOUS = `p-${randomBytes(3).toString('hex')}`;
const TAG_DROP = `d-${randomBytes(3).toString('hex')}`;
const TAG_REWRITE = `r-${randomBytes(3).toString('hex')}`;
const TAG_ADD = `a-${randomBytes(3).toString('hex')}`;
const STACK_TEST_TIMEOUT_MS = 1_800_000;
const stacks: Stack[] = [];
const checks: UpgradeCheck[] = [];
const NAME_MAIN = 'keeps the saved work, applies the new migrations once, and lets the previous image come back';
const NAME_DROP = 'rejects a migration that drops the table of drafts and named views';
const NAME_REWRITE = 'rejects a migration that rewrites the saved draft';
const NAME_ADD = 'does not reject a migration that only adds a table';
const NAME_PULL = 'fails and starts no stack when the previous image cannot be pulled, naming the reference and the error';
const NAME_DIGEST = 'the previous image has a registry digest';
const EXPECTED_CHECKS = [NAME_MAIN, NAME_DROP, NAME_REWRITE, NAME_ADD, NAME_PULL, NAME_DIGEST];
const RECORD_DIR = process.env['NEBURYX_UPGRADE_RECORD_DIR'];
const DRY_RUN = (process.env['NEBURYX_UPGRADE_DRY_RUN'] ?? '') !== '';

const NEXT_MIGRATION = String(
  Math.max(...readdirSync(fileURLToPath(new URL('../../migrations', import.meta.url))).flatMap((name) => Number(/^(\d{4})-/.exec(name)?.[1] ?? Number.NaN) || [])) + 1,
).padStart(4, '0');

/** Pulls an image, and says which reference could not be pulled and why. */
async function pullImage(reference: string): Promise<void> {
  const pulled = await docker(['pull', reference]);
  if (pulled.code !== 0) throw new Error(`could not pull ${reference}: ${pulled.stderr.trim() || pulled.stdout.trim()}`);
}

/** Runs one check of the run and keeps whether it passed for the record; a failure is thrown on. */
async function checked(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false });
    throw error;
  }
}

function treeState(): { readonly commit: string; readonly dirty: boolean } {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository }).toString().trim();
  return { commit, dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repository }).toString().trim() !== '' };
}

/** Pulls the previous image, tags it for the stack under `localTag` and reads its digest and ID; nothing is started. */
async function preparePrevious(reference: string, localTag: string): Promise<{ readonly digest: string | undefined; readonly imageId: string; readonly pulledHere: boolean }> {
  splitReference(reference);
  const pulledHere = !(await imagePresent(reference));
  await pullImage(reference);
  await dockerOk(['tag', reference, `${IMAGE}:${localTag}`]);
  const digests = JSON.parse(await dockerOk(['image', 'inspect', '--format', '{{json .RepoDigests}}', reference])) as string[];
  return { digest: digestOf(digests, reference), imageId: await dockerOk(['image', 'inspect', '--format', '{{.Id}}', reference]), pulledHere };
}

async function imagePresent(reference: string): Promise<boolean> {
  return (await docker(['image', 'inspect', '--format', '{{.Id}}', reference])).code === 0;
}

/** The names of the migrations an image ships, as the migrate step records them. */
async function shippedMigrations(reference: string): Promise<readonly string[]> {
  const listing = await dockerOk(['run', '--rm', '--entrypoint', 'ls', reference, '/app/migrations']);
  return listing.split('\n').flatMap((name) => (name.endsWith('.sql') ? name.slice(0, -'.sql'.length) : []));
}

async function appliedMigrations(stack: Stack): Promise<readonly string[]> {
  return (await stack.psql('SELECT name FROM kysely_migration ORDER BY name')).stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

async function migrateExitCode(stack: Stack): Promise<string> {
  return dockerOk(['inspect', '--format', '{{.State.ExitCode}}', await stack.containerId('migrate')]);
}

function settings(): Record<string, string> {
  return { DEMO_NEO4J_PASSWORD: randomBytes(12).toString('hex'), NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64'), NEBURYX_DEMO_LOADER_IMAGE: LOADER_IMAGE };
}

async function demoStack(tag: string): Promise<Stack> {
  const stack = await Stack.create({ image: IMAGE, tag, file: demoComposeFile, waitSeconds: DEMO_WAIT_SECONDS, settings: settings() });
  stacks.push(stack);
  onTestFinished(async () => {
    await stack.destroy();
    stacks.splice(stacks.indexOf(stack), 1);
  });
  return stack;
}

async function json<T>(url: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as T };
}

const jsonInit = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function read<T>(url: string): Promise<Read<T>> {
  try {
    const answer = await json<T>(url);
    return answer.status === 200 ? { ok: true, value: answer.body } : { ok: false, error: `HTTP ${answer.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The investigation, its draft and its named views as the API answers them now. */
async function readSavedWork(stack: Stack, id: string): Promise<SavedWork> {
  const record = await read<{ investigation: Record<string, unknown>; draft: Record<string, unknown> }>(`${stack.url}/v1/investigations/${id}`);
  const views = await read<{ items: Record<string, unknown>[] }>(`${stack.url}/v1/investigations/${id}/views`);
  return {
    investigation: record.ok ? { ok: true, value: record.value.investigation } : record,
    draft: record.ok ? { ok: true, value: record.value.draft } : record,
    views: views.ok ? { ok: true, value: views.value.items } : views,
  };
}

/** Opens the demo case, saves a note in its draft and saves a named view, the way a person does, and returns the investigation's ID. */
async function saveWork(stack: Stack): Promise<string> {
  const sources = sourcesResponseSchema.parse((await json<unknown>(`${stack.url}/v1/sources`)).body);
  const demo = sources.items.find((item) => item.demoCase !== null);
  if (demo?.demoCase == null) throw new Error('the demo stack offers no demo case');
  const { entityType, stableId, caseRef } = demo.demoCase;
  const opened = await json<{ investigation: { id: string }; draft: { version: number } }>(
    `${stack.url}/v1/investigations`,
    jsonInit('POST', { sourceId: demo.id, entity: { sourceId: demo.id, entityType, stableId }, caseRef, mask: false }),
  );
  expect(opened.status, 'the demo case opens').toBe(201);
  const id = opened.body.investigation.id;
  const current = await json<{ draft: { version: number; layout: unknown; queryContext: unknown } }>(`${stack.url}/v1/investigations/${id}`);
  const saved = await json<{ version: number }>(
    `${stack.url}/v1/investigations/${id}/draft`,
    jsonInit('PUT', { layout: current.body.draft.layout, queryContext: current.body.draft.queryContext, notes: 'A note saved before the upgrade.' }, { 'if-match': `"${current.body.draft.version}"` }),
  );
  expect(saved.status, 'the draft is saved').toBe(200);
  const view = await json<unknown>(`${stack.url}/v1/investigations/${id}/views`, jsonInit('POST', { name: 'Before the upgrade', notes: 'A view saved before the upgrade.' }, { 'if-match': `"${saved.body.version}"` }));
  expect(view.status, 'the named view is saved').toBe(201);
  return id;
}

/** Restores the named view into the draft and answers the layout the draft then holds. */
async function restoredLayout(stack: Stack, id: string): Promise<Read<unknown>> {
  const views = await read<{ items: { id: string }[] }>(`${stack.url}/v1/investigations/${id}/views`);
  const record = await read<{ draft: { version: number } }>(`${stack.url}/v1/investigations/${id}`);
  const view = views.ok ? views.value.items[0] : undefined;
  if (view === undefined || !record.ok) return { ok: false, error: 'no view or no draft to restore' };
  const answer = await json<{ draft: { layout: unknown } }>(`${stack.url}/v1/investigations/${id}/views/${view.id}/restore`, { method: 'POST', headers: { 'if-match': `"${record.value.draft.version}"` } });
  return answer.status === 200 ? { ok: true, value: answer.body.draft.layout } : { ok: false, error: `HTTP ${answer.status}` };
}

async function sourceStates(stack: Stack): Promise<ReadonlyMap<string, string>> {
  const answer = sourcesResponseSchema.parse((await json<unknown>(`${stack.url}/v1/sources`)).body);
  return new Map(answer.items.map((item) => [item.id, item.state]));
}

/** A stack on the previous image with work saved in it. */
async function previousWithWork(): Promise<{ readonly stack: Stack; readonly id: string; readonly before: SavedWork }> {
  const stack = await demoStack(TAG_PREVIOUS);
  const started = await stack.up();
  expect(started.code, started.stderr).toBe(0);
  const id = await saveWork(stack);
  return { stack, id, before: await readSavedWork(stack, id) };
}

describe.skipIf(FROM === undefined)('an upgrade from the previous published image', () => {
  const reference = FROM ?? '';
  const facts: { digest?: string; previousId?: string; buildId?: string; pulledHere: boolean; previousMigrations: readonly string[]; buildMigrations: readonly string[]; appliedBefore: readonly string[]; appliedAfter: readonly string[] } = {
    pulledHere: false,
    previousMigrations: [],
    buildMigrations: [],
    appliedBefore: [],
    appliedAfter: [],
  };
  let refused = false;

  beforeAll(async () => {
    splitReference(reference);
    if (RECORD_DIR !== undefined) recordFolder(RECORD_DIR, repository);
    const refusal = dirtyTreeRefusal(treeState().dirty, DRY_RUN);
    if (refusal !== undefined) {
      refused = true;
      throw new Error(refusal);
    }
    const previous = await preparePrevious(reference, TAG_PREVIOUS);
    facts.pulledHere = previous.pulledHere;
    facts.digest = previous.digest;
    facts.previousId = previous.imageId;
    checks.push({ name: NAME_DIGEST, passed: /^sha256:[0-9a-f]{64}$/.test(previous.digest ?? '') });
    if (images.built) {
      await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG}`, '.'], repository);
      await dockerStream(['build', '-f', 'deploy/demo/loader.Dockerfile', '-t', LOADER_IMAGE, '.'], repository);
    }
    facts.buildId = await dockerOk(['image', 'inspect', '--format', '{{.Id}}', `${IMAGE}:${TAG}`]);
    facts.previousMigrations = await shippedMigrations(`${IMAGE}:${TAG_PREVIOUS}`);
    facts.buildMigrations = await shippedMigrations(`${IMAGE}:${TAG}`);
    await buildDerivedImage(`${IMAGE}:${TAG}`, `${IMAGE}:${TAG_DROP}`, `${NEXT_MIGRATION}-drop-saved-views.sql`, 'DROP TABLE saved_views CASCADE;\n');
    await buildDerivedImage(`${IMAGE}:${TAG}`, `${IMAGE}:${TAG_REWRITE}`, `${NEXT_MIGRATION}-rewrite-draft.sql`, "UPDATE saved_views SET notes = 'rewritten by a migration' WHERE kind = 'draft';\n");
    await buildDerivedImage(`${IMAGE}:${TAG}`, `${IMAGE}:${TAG_ADD}`, `${NEXT_MIGRATION}-add-table.sql`, 'CREATE TABLE upgrade_additive_marker (id integer PRIMARY KEY);\n');
  });

  /** Writes the record of the run, from the fixed list of checks, and reads it back: a check that did not run is a failed one. */
  function writeRunRecord(): void {
    if (RECORD_DIR === undefined || refused) return;
    const { commit, dirty } = treeState();
    const rendered = renderRecord({
      startedAt: new Date(),
      commit,
      dirty,
      dryRun: DRY_RUN,
      previous: { reference, digest: facts.digest, imageId: facts.previousId, migrations: facts.previousMigrations },
      build: { reference: `${IMAGE}:${TAG}`, imageId: facts.buildId, migrations: facts.buildMigrations },
      applied: { before: facts.appliedBefore, after: facts.appliedAfter },
      checks: withExpected(EXPECTED_CHECKS, checks),
    });
    const folder = recordFolder(RECORD_DIR, repository);
    writeRecord(folder, rendered);
    const markdown = readFileSync(join(folder, `${rendered.name}.md`), 'utf8');
    expect(markdown.split('\n').filter((line) => line.startsWith('Commit: '))).toEqual([`Commit: ${commit}`]);
    expect(markdown.split('\n').filter((line) => line.startsWith('Result: '))).toHaveLength(1);
    expect(markdown).toContain(reference);
    expect(JSON.parse(readFileSync(join(folder, `${rendered.name}.json`), 'utf8'))).toMatchObject({ commit, dryRun: DRY_RUN });
  }

  afterAll(async () => {
    try {
      writeRunRecord();
    } finally {
      try {
        await destroyAll(stacks);
      } finally {
        for (const tag of [TAG_ADD, TAG_REWRITE, TAG_DROP, TAG_PREVIOUS]) await docker(['rmi', '-f', `${IMAGE}:${tag}`]);
        if (images.built) {
          await docker(['rmi', '-f', `${IMAGE}:${TAG}`]);
          await docker(['rmi', '-f', LOADER_IMAGE]);
        }
        if (facts.pulledHere) await docker(['rmi', '-f', reference]);
      }
    }
  });

  it('keeps the saved work, applies the new migrations once, and lets the previous image come back', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    await checked(NAME_MAIN, async () => {
      const stack = await demoStack(TAG_PREVIOUS);
      const started = await stack.up();
      expect(started.code, started.stderr).toBe(0);
      expect(await migrateExitCode(stack)).toBe('0');
      const shippedBefore = await shippedMigrations(`${IMAGE}:${TAG_PREVIOUS}`);
      const appliedBefore = await appliedMigrations(stack);
      expect(appliedBefore, 'the previous image applied what it ships and nothing else').toEqual([...shippedBefore].sort());
      const id = await saveWork(stack);
      const before = await readSavedWork(stack, id);
      expect(before.draft.ok && before.draft.value['notes'], 'saving a view leaves its notes in the draft').toBe('A view saved before the upgrade.');
      expect(before.views.ok && before.views.value.length).toBe(1);
      const sourcesBefore = await sourceStates(stack);
      expect(sourcesBefore.size, 'the demo stack lists sources').toBeGreaterThan(0);
      facts.appliedBefore = appliedBefore;

      stack.setTag(TAG);
      const upgraded = await stack.up();
      expect(upgraded.code, upgraded.stderr).toBe(0);
      expect(await migrateExitCode(stack)).toBe('0');
      const shippedNow = await shippedMigrations(`${IMAGE}:${TAG}`);
      const appliedAfter = await appliedMigrations(stack);
      const added = shippedNow.filter((name) => !shippedBefore.includes(name));
      expect(added.length, 'the build under test ships migrations the previous image does not').toBeGreaterThan(0);
      expect(appliedAfter).toEqual([...shippedNow].sort());
      expect(appliedAfter.some((name) => name.endsWith('user-preferences'))).toBe(true);
      expect((await fetch(`${stack.url}/readyz`)).status).toBe(200);
      const sourcesAfter = await sourceStates(stack);
      expect([...sourcesAfter.keys()].sort(), 'the same sources are listed after the upgrade').toEqual([...sourcesBefore.keys()].sort());
      for (const [name] of sourcesBefore) expect(sourcesAfter.get(name), `source ${name} after the upgrade`).toBe('connected');
      facts.appliedAfter = appliedAfter;
      expect(compareSavedWork(before, await readSavedWork(stack, id))).toEqual([]);
      expect(compareRestoredView(before.draft.ok ? before.draft.value['layout'] : undefined, await restoredLayout(stack, id)), 'the view restored after the upgrade').toEqual([]);
      // restoring writes the draft (a new version), so what the later steps compare with is the work as it stands after the restore
      const restored = await readSavedWork(stack, id);
      expect(compareSavedWork({ ...before, draft: restored.draft }, restored)).toEqual([]);

      const migrateStartedAt = async (): Promise<string> => dockerOk(['inspect', '--format', '{{.State.StartedAt}}', await stack.containerId('migrate')]);
      const startedBefore = await migrateStartedAt();
      const again = await stack.up();
      expect(again.code, again.stderr).toBe(0);
      expect(await migrateStartedAt(), 'the migrate step ran a second time').not.toBe(startedBefore);
      expect((await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout).toContain('nothing to apply');
      expect(await appliedMigrations(stack)).toEqual(appliedAfter);

      stack.setTag(TAG_PREVIOUS);
      const returned = await stack.up();
      expect(returned.code, returned.stderr).toBe(0);
      expect(await migrateExitCode(stack)).toBe('0');
      expect((await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout).toContain('nothing to apply');
      expect(await appliedMigrations(stack), 'the previous image removed, reordered and rewrote no applied migration').toEqual(appliedAfter);
      expect((await fetch(`${stack.url}/readyz`)).status).toBe(200);
      expect(compareSavedWork(restored, await readSavedWork(stack, id))).toEqual([]);
    });
  });

  it('rejects a migration that drops the table of drafts and named views', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    await checked(NAME_DROP, async () => {
      const { stack, id, before } = await previousWithWork();
      stack.setTag(TAG_DROP);
      const upgraded = await stack.up();
      expect(upgraded.code, upgraded.stderr).toBe(0);
      expect(await migrateExitCode(stack)).toBe('0');
      expect((await fetch(`${stack.url}/readyz`)).status, 'the stack is up, so the failed reads are the drop and not a stack that never started').toBe(200);
      const differences = compareSavedWork(before, await readSavedWork(stack, id));
      expect(differences.some((line) => line.startsWith('draft')), differences.join('\n')).toBe(true);
      expect(differences.some((line) => line.startsWith('named view')), differences.join('\n')).toBe(true);
    });
  });

  it('rejects a migration that rewrites the saved draft', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    await checked(NAME_REWRITE, async () => {
      const { stack, id, before } = await previousWithWork();
      stack.setTag(TAG_REWRITE);
      const upgraded = await stack.up();
      expect(upgraded.code, upgraded.stderr).toBe(0);
      expect(compareSavedWork(before, await readSavedWork(stack, id))).toEqual(['draft document notes: changed']);
    });
  });

  it('does not reject a migration that only adds a table', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    await checked(NAME_ADD, async () => {
      const { stack, id, before } = await previousWithWork();
      stack.setTag(TAG_ADD);
      const upgraded = await stack.up();
      expect(upgraded.code, upgraded.stderr).toBe(0);
      expect(compareSavedWork(before, await readSavedWork(stack, id))).toEqual([]);
    });
  });

  it('fails and starts no stack when the previous image cannot be pulled, naming the reference and the error', async () => {
    await checked(NAME_PULL, async () => {
      const wrong = `${splitReference(reference).image}-no-such-image:0`;
      const localTag = `x-${randomBytes(3).toString('hex')}`;
      const ofThisRun = (): Promise<string> => dockerOk(['ps', '-a', '-q', '--no-trunc', '--filter', `ancestor=${IMAGE}:${TAG_PREVIOUS}`, '--filter', `ancestor=${IMAGE}:${TAG}`]);
      const containersBefore = await ofThisRun();
      await expect(preparePrevious(wrong, localTag)).rejects.toThrow(new RegExp(`could not pull ${wrong.replaceAll('.', '\\.')}: .+`));
      expect((await docker(['image', 'inspect', `${IMAGE}:${localTag}`])).code, 'nothing was tagged for a stack').not.toBe(0);
      expect(await ofThisRun(), 'no container of this run was made').toBe(containersBefore);
    });
  });

  it('has the digest of the previous image', () => {
    expect(facts.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

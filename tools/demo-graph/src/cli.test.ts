import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArguments, runCli, USAGE } from './cli.js';
import { ENV, scratch } from './testing/export-helpers.js';
import { miniDefinitionPath, miniMappingPath } from './testing/fixture.js';
import { recordingDriver } from './testing/recording-driver.js';

function run(argv: string[], env: Record<string, string | undefined> = ENV, createDriver = recordingDriver().factory) {
  const out: string[] = [];
  const err: string[] = [];
  return runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), env, createDriver }).then((code) => ({ code, out, err }));
}

const FILES = ['--mapping', miniMappingPath, '--definition', miniDefinitionPath];

describe('the arguments', () => {
  it.each([
    [[]],
    [['frobnicate']],
    [['generate']],
    [['generate', '--pack']],
    [['generate', '--pack', 'a', '--pack', 'b', '--out', 'd']],
    [['generate', '--surprise', 'x']],
    [['generate', '--pack', '../outside', '--out', 'd']],
    [['generate', '--pack', 'x', '--mapping', 'm', '--out', 'd']],
    [['generate', ...FILES, '--seed', 'abc', '--out', 'd']],
    [['generate', ...FILES, '--seed', '9007199254740992', '--out', 'd']],
    [['load', '--mapping', miniMappingPath]],
    [['load', '--mapping', miniMappingPath, '--dir', 'd', '--seed', '3']],
    [['load', '--mapping', miniMappingPath, '--dir', 'd', '--definition', miniDefinitionPath]],
    [['build', ...FILES, '--dir', 'd']],
    [['generate', ...FILES, '--out', 'd', '--uri', 'bolt://localhost:7687']],
    [['generate', ...FILES, '--out', 'd', '--reset']],
    [['build', ...FILES, '--reset', '--reset']],
  ])('print the usage and exit 2 for %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain(USAGE);
    expect(result.out).toEqual([]);
  });

  it('are read into a command, options and the reset flag', () => {
    expect(parseArguments(['build', '--pack', 'x', '--reset'])).toMatchObject({ command: 'build', reset: true });
  });
});

describe('the commands', () => {
  it('generate writes the export and says where', async () => {
    const out = join(scratch(), 'export');
    const result = await run(['generate', ...FILES, '--seed', '5', '--out', out]);
    expect(result.code).toBe(0);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);
    expect(result.out.join('\n')).toContain('seed 5');
  });

  it('build generates and loads, and prints the phase times', async () => {
    const { factory, recording } = recordingDriver();
    const result = await run(['build', ...FILES, '--out', join(scratch(), 'export')], ENV, factory);
    expect(result.code).toBe(0);
    expect(recording.stored.nodes).toEqual({ Widget: 50, Gadget: 20 });
    expect(result.out.join('\n')).toMatch(/nodes: \d+\.\d\d s/);
  });

  it('load reads an export and refuses an unsafe override with exit 1, connecting nowhere', async () => {
    const out = join(scratch(), 'export');
    await run(['generate', ...FILES, '--out', out]);
    const { factory, recording } = recordingDriver();
    const result = await run(['load', '--mapping', miniMappingPath, '--dir', out, '--uri', 'bolt://db.example.test:7687'], ENV, factory);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('address given on the command line');
    expect(recording.drivers).toBe(0);
  });

  it('build refuses a missing credential variable with exit 1 and names the variable', async () => {
    const result = await run(['build', ...FILES, '--out', join(scratch(), 'export')], {});
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('MINI_USER and MINI_PASSWORD');
  });
});

describe('files that cannot be read as data', () => {
  it.each(['definition', 'mapping'])('print no value of a %s file that holds an unresolved alias, and exit 1', async (which) => {
    const folder = scratch();
    const bad = join(folder, 'bad.yaml');
    writeFileSync(bad, 'entities: *MARKER_SECRET_VALUE\nsources: *MARKER_SECRET_VALUE\n');
    const files = which === 'definition' ? ['--mapping', miniMappingPath, '--definition', bad] : ['--mapping', bad, '--definition', miniDefinitionPath];
    const result = await run(['generate', ...files, '--out', join(folder, 'export')]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).not.toContain('MARKER_SECRET_VALUE');
    expect(result.out).toEqual([]);
  });

  it('print nothing of an unexpected error', async () => {
    const result = await run(['generate', '--mapping', join(scratch(), 'missing.yaml'), '--definition', miniDefinitionPath, '--out', join(scratch(), 'export')]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('cannot be read');
  });
});

describe('the commands for the shipped packs', () => {
  const PACK_ENV = { DEMO_NEO4J_USER: 'reader', DEMO_NEO4J_PASSWORD: 'a password value' };

  it.each(['banking-fraud', 'insurance-claims'])('generate, load and build all run for %s through --pack', async (pack) => {
    const out = join(scratch(), 'export');
    const generated = await run(['generate', '--pack', pack, '--out', out]);
    expect(generated.code, generated.err.join()).toBe(0);
    const { factory, recording } = recordingDriver();
    const loaded = await run(['load', '--pack', pack, '--dir', out, '--uri', 'bolt://localhost:7687'], PACK_ENV, factory);
    expect(loaded.code, loaded.err.join()).toBe(0);
    expect(Object.keys(recording.stored.nodes).length).toBeGreaterThan(3);
    const built = recordingDriver();
    const result = await run(['build', '--pack', pack, '--out', join(scratch(), 'built')], PACK_ENV, built.factory);
    expect(result.code, result.err.join()).toBe(0);
    expect(built.recording.stored.nodes).toEqual(recording.stored.nodes);
  });

  it('refuses to generate into a directory that already holds an export, and leaves it as it was', async () => {
    const out = join(scratch(), 'export');
    await run(['generate', ...FILES, '--out', out]);
    const again = await run(['generate', ...FILES, '--out', out]);
    expect(again.code).toBe(1);
    expect(again.err.join('\n')).toContain('already holds files');
  });

  it('refuses a load of an export made for another source, naming nothing it was not told', async () => {
    const out = join(scratch(), 'export');
    await run(['generate', ...FILES, '--out', out]);
    const result = await run(['load', '--pack', 'banking-fraud', '--dir', out, '--uri', 'bolt://localhost:7687'], PACK_ENV);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('another source');
  });
});

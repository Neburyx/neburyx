import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CombineError, combinePacks } from './combine.js';
import { DefinitionError, readDefinition } from './definition.js';
import { ExportExistsError, writeExport } from './export.js';
import { generate } from './generate.js';
import { LoadError, loadExport, type LoaderDriverFactory } from './load.js';
import { MappingError, readMappingSource } from './mapping.js';
import { packFiles, PackNameError } from './packs.js';
import { SafetyError } from './safety.js';
import { SchemaError } from './schema.js';
import { ExportError } from './validate.js';

export const USAGE = `usage:
  demo-graph generate (--pack <name> | --mapping <file> --definition <file>) [--source <id>] [--seed <n>] --out <dir>
  demo-graph load     (--pack <name> | --mapping <file>) [--source <id>] --dir <dir> [--uri <address>] [--reset]
  demo-graph build    (--pack <name> | --mapping <file> --definition <file>) [--source <id>] [--seed <n>] [--out <dir>] [--uri <address>] [--reset]
  demo-graph combine  --packs <name>,<name>... [--addresses <source-id>=<bolt-address>,...] --out <file>`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly createDriver?: LoaderDriverFactory;
  readonly packsFolder?: string;
}

interface Arguments {
  readonly command: 'generate' | 'load' | 'build' | 'combine';
  readonly values: ReadonlyMap<string, string>;
  readonly reset: boolean;
}

type Command = Arguments['command'];

const ALLOWED: Readonly<Record<Command, ReadonlySet<string>>> = {
  generate: new Set(['pack', 'mapping', 'definition', 'source', 'seed', 'out']),
  load: new Set(['pack', 'mapping', 'source', 'dir', 'uri', 'reset']),
  build: new Set(['pack', 'mapping', 'definition', 'source', 'seed', 'out', 'uri', 'reset']),
  combine: new Set(['packs', 'addresses', 'out']),
};
const REQUIRED: Readonly<Record<Command, readonly string[]>> = { generate: ['out'], load: ['dir'], build: [], combine: ['packs', 'out'] };

export function parseArguments(argv: readonly string[]): Arguments | undefined {
  const [command, ...rest] = argv;
  if (command !== 'generate' && command !== 'load' && command !== 'build' && command !== 'combine') return undefined;
  const allowed = ALLOWED[command];
  const values = new Map<string, string>();
  let reset = false;
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    const name = option?.startsWith('--') ? option.slice(2) : '';
    if (name === 'reset' && allowed.has('reset') && !reset) {
      reset = true;
      continue;
    }
    const value = rest[index + 1];
    if (name === 'reset' || !allowed.has(name) || value === undefined || value.startsWith('--') || values.has(name)) return undefined;
    values.set(name, value);
    index += 1;
  }
  if (REQUIRED[command].some((required) => !values.has(required))) return undefined;
  return { command, values, reset };
}

function sourceFiles(values: ReadonlyMap<string, string>, needsDefinition: boolean): { mapping: string; definition: string } | undefined {
  const pack = values.get('pack');
  if (pack !== undefined) {
    if (values.has('mapping') || values.has('definition')) return undefined;
    const files = packFiles(pack);
    return { mapping: files.mapping, definition: files.definition };
  }
  const mapping = values.get('mapping');
  const definition = values.get('definition');
  if (mapping === undefined || (needsDefinition && definition === undefined)) return undefined;
  return { mapping, definition: definition ?? '' };
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArguments(argv);
  const needsDefinition = parsed?.command !== 'load';
  try {
    if (parsed?.command === 'combine') {
      const packs = (parsed.values.get('packs') ?? '').split(',');
      const out = parsed.values.get('out') ?? '';
      if (packs.some((pack) => pack === '') || new Set(packs).size !== packs.length) {
        io.err(USAGE);
        return 2;
      }
      const addresses = new Map<string, string>();
      for (const pair of (parsed.values.get('addresses') ?? '').split(',').filter((entry) => entry !== '')) {
        const at = pair.indexOf('=');
        const id = pair.slice(0, at);
        if (at < 1 || addresses.has(id)) {
          io.err(USAGE);
          return 2;
        }
        addresses.set(id, pair.slice(at + 1));
      }
      combinePacks(packs, out, io.packsFolder, addresses);
      io.out(`wrote ${out} with the sources of ${packs.length} packs`);
      return 0;
    }
    const files = parsed === undefined ? undefined : sourceFiles(parsed.values, needsDefinition);
    if (parsed === undefined || files === undefined) {
      io.err(USAGE);
      return 2;
    }
    const seedText = parsed.values.get('seed');
    const seed = seedText === undefined ? undefined : Number(seedText);
    if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
      io.err(USAGE);
      return 2;
    }
    const source = readMappingSource(files.mapping, parsed.values.get('source'));
    let directory = parsed.command === 'load' ? parsed.values.get('dir') : parsed.values.get('out');
    if (parsed.command !== 'load') {
      const definition = readDefinition(files.definition, source);
      const usedSeed = seed ?? definition.seed;
      directory ??= mkdtempSync(join(tmpdir(), 'demo-graph-'));
      const manifest = writeExport(directory, generate(source, definition, usedSeed));
      io.out(`wrote ${manifest.files.length} files for seed ${usedSeed} to ${directory}`);
    }
    if (parsed.command === 'generate') return 0;
    if (directory === undefined) {
      io.err(USAGE);
      return 2;
    }
    const report = await loadExport({
      directory,
      source,
      override: parsed.values.get('uri'),
      env: io.env,
      reset: parsed.reset,
      ...(io.createDriver === undefined ? {} : { createDriver: io.createDriver }),
      onPhase: (name, milliseconds) => io.out(`${name}: ${(milliseconds / 1000).toFixed(2)} s`),
    });
    io.out(`loaded in ${(report.totalMilliseconds / 1000).toFixed(2)} s`);
    return 0;
  } catch (error) {
    if (error instanceof PackNameError) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    const known = [CombineError, DefinitionError, ExportError, ExportExistsError, LoadError, MappingError, SafetyError, SchemaError].some((type) => error instanceof type);
    io.err(known && error instanceof Error ? error.message : 'the command failed');
    return 1;
  }
}

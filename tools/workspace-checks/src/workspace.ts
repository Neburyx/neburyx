import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { isBuildCommand, parseStep, stepsOf, withSharedPrebuild } from '../../ci/prebuild-lists.mjs';

export const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const workspaceFileSchema = z.object({ packages: z.array(z.string()), engineStrict: z.boolean().optional() });
const packageJsonSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});
const showConfigSchema = z.object({ compilerOptions: z.object({ strict: z.boolean().optional() }) });

export type PackageJson = z.infer<typeof packageJsonSchema>;

export function readPackageJson(dir: string): PackageJson {
  return packageJsonSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
}

function readWorkspaceFile(): z.infer<typeof workspaceFileSchema> {
  const file = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  return workspaceFileSchema.parse(parse(file));
}

export function workspaceGlobs(): readonly string[] {
  return readWorkspaceFile().packages;
}

export function enforcesEngines(): boolean {
  return readWorkspaceFile().engineStrict === true;
}

export function workspacePackageDirs(): readonly string[] {
  return workspaceGlobs().flatMap((glob) => {
    const parent = join(repoRoot, glob.replace(/\/\*$/, ''));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json')))
      .map((entry) => join(parent, entry.name));
  });
}

export function resolvesStrict(dir: string): boolean {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const output = execFileSync(process.execPath, [tsc, '--showConfig', '-p', dir], { encoding: 'utf8' });
  return showConfigSchema.parse(JSON.parse(output)).compilerOptions.strict === true;
}

const EE_PACKAGE = /^@neburyx\/ee-/;
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

export function eeDependencyViolations(pkg: PackageJson): readonly string[] {
  return RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {}).filter((name) => EE_PACKAGE.test(name)).map((name) => `${field}: ${name}`));
}

export function rangeViolations(pkg: PackageJson): readonly string[] {
  return dependencyFields.flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(([, version]) => !version.startsWith('workspace:') && !exactVersion.test(version))
      .map(([name, version]) => `${field}: ${name}@${version}`),
  );
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist']);
const STATIC_IMPORT = /^[ \t]*(?:import\s*|\}\s*from\s*|(?:import|export)\b[^'"\n]*\bfrom\s*)['"](@neburyx\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/gm;
const DYNAMIC_IMPORT = /\b(?:import|require)\(\s*['"](@neburyx\/[a-z0-9-]+)(?:\/[^'"]*)?['"]\s*\)/g;

type Scripts = Readonly<Record<string, string>>;

function sourceFiles(dir: string): readonly string[] {
  const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures');
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) || path === fixtures ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

export function undeclaredWorkspaceImports(dir: string): readonly string[] {
  const pkg = readPackageJson(dir);
  const declared = new Set(dependencyFields.flatMap((field) => Object.keys(pkg[field] ?? {})));
  const imported = sourceFiles(dir).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(STATIC_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map((match) => match[1] ?? '');
  });
  return [...new Set(imported)].filter((name) => name !== pkg.name && !declared.has(name)).sort();
}

const filteredSteps = (scripts: Scripts) =>
  Object.entries(scripts).flatMap(([script, command]) => {
    const all = stepsOf(withSharedPrebuild(scripts, command)).map((step) => ({ step, parsed: parseStep(step) }));
    return all.filter(({ parsed }) => parsed.filters.length > 0).map(({ step, parsed }) => ({ script, step, ...parsed, build: isBuildCommand(parsed.command) }));
  });

export function handKeptBuildFilters(scripts: Scripts): readonly string[] {
  return filteredSteps(scripts).flatMap(({ script, build, filters }) => (build ? filters.filter((selector) => !selector.includes('...')).map((selector) => `${script}: ${selector}`) : []));
}

/** pnpm exits 0 when a selection matches no package, so a renamed package would pass without `--fail-if-no-match`. */
export function unguardedFilterSteps(scripts: Scripts): readonly string[] {
  return filteredSteps(scripts).filter(({ guarded }) => !guarded).map(({ script, step }) => `${script}: ${step}`);
}

/** Only scripts that have a build step are judged. */
export function unbuiltRunTargets(scripts: Scripts): readonly string[] {
  const steps = filteredSteps(scripts);
  return [...new Set(steps.map(({ script }) => script))].flatMap((script) => {
    const own = steps.filter((step) => step.script === script);
    const selectors = own.filter(({ build }) => build).flatMap(({ filters }) => filters);
    if (selectors.length === 0) return [];
    const covered = (name: string): boolean => selectors.includes('*^...') || selectors.includes(`${name}^...`) || selectors.includes(`${name}...`);
    return own.filter(({ build }) => !build).flatMap(({ filters }) => filters.filter((name) => !covered(name)).map((name) => `${script}: ${name}`));
  });
}

/** One wrong name among several filters only shrinks the build; `--fail-if-no-match` fails only when every filter matches nothing. */
export function unknownFilterNames(scripts: Scripts, known: ReadonlySet<string>): readonly string[] {
  return filteredSteps(scripts).flatMap(({ script, filters }) =>
    filters
      .map((selector) => selector.replace(/\^?\.\.\./g, ''))
      .filter((name) => name !== '*' && name !== '' && !known.has(name))
      .map((name) => `${script}: ${name}`),
  );
}

export function readRootScripts(): Scripts {
  return z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).scripts;
}

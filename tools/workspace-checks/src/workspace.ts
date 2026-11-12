import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

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

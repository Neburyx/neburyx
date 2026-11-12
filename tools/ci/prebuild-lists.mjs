import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHARED_PREBUILD = /\bpnpm build:deps\b/g;
const TOKEN = /"[^"]*"|'[^']*'|\S+/g;
const VALUE_FLAGS = new Set(['-C', '--dir', '--workspace-concurrency', '--reporter', '--changed-files-ignore-pattern', '--test-pattern']);
const unquote = (token) => token.replace(/^(["'])(.*)\1$/, '$2');

export const stepsOf = (command) => command.split('&&').map((step) => step.trim());

export const withSharedPrebuild = (scripts, command) => command.replace(SHARED_PREBUILD, () => scripts['build:deps'] ?? '');

export function parseStep(step) {
  const tokens = (step.match(TOKEN) ?? []).map(unquote);
  if (tokens[0] !== 'pnpm') return { filters: [], guarded: false, command: undefined };
  const filters = [];
  let guarded = false;
  let command;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--filter' || token === '--filter-prod' || token === '-F') filters.push(tokens[(index += 1)] ?? '');
    else if (token.startsWith('--filter=') || token.startsWith('--filter-prod=') || token.startsWith('-F=')) filters.push(token.slice(token.indexOf('=') + 1));
    else if (token === '--fail-if-no-match') guarded = true;
    else if (VALUE_FLAGS.has(token)) index += 1;
    else if (!token.startsWith('-') && token !== 'run' && command === undefined) command = token;
  }
  return { filters, guarded, command };
}

export const isBuildCommand = (command) => command === 'build' || (command?.startsWith('build:') ?? false);

export function buildSteps(scripts) {
  return Object.entries(scripts).flatMap(([script, command]) =>
    stepsOf(withSharedPrebuild(scripts, command))
      .map(parseStep)
      .filter(({ filters, command: run }) => filters.length > 0 && isBuildCommand(run))
      .map(({ filters }) => ({ script, selectors: filters })),
  );
}

export function packagesOf({ selectors }, resolve) {
  const names = selectors.flatMap((selector) => (selector.includes('...') ? resolve(selector) : [selector]));
  return [...new Set(names)];
}

/** One package at a time, so pnpm prints them in build order and the same order on every run. */
export function resolveWithPnpm(selector, exec = spawnSync) {
  const result = exec('pnpm', ['--workspace-concurrency=1', '--fail-if-no-match', '--filter', selector, '--reporter-hide-prefix', 'exec', 'node', '-p', 'require("./package.json").name'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pnpm could not resolve ${selector}: ${result.stderr}`);
  return result.stdout.split('\n').filter((line) => line.startsWith('@'));
}

export function readScripts(revision, exec) {
  if (revision === undefined) return JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  const result = exec('git', ['show', `${revision}:package.json`]);
  if (result.status !== 0) throw new Error(`git could not read package.json at ${revision}`);
  return JSON.parse(result.stdout).scripts;
}

function main(argv) {
  const revision = argv[0] === '--from-git' ? argv[1] : undefined;
  const exec = (tool, args) => spawnSync(tool, args, { encoding: 'utf8' });
  try {
    for (const step of buildSteps(readScripts(revision, exec))) console.log(`${step.script}: ${packagesOf(step, resolveWithPnpm).join(' ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));

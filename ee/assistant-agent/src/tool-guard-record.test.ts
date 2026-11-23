import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = createRequire(import.meta.url);
const recordPath = fileURLToPath(new URL('../tool-guard-versions.json', import.meta.url));

/** The version of a package as installed: the direct dependencies from this package, the peers deepagents resolves through deepagents itself. */
function installedVersion(name: string, direct: boolean): string {
  const from = direct ? here : createRequire(here.resolve('deepagents/package.json'));
  return (from(`${name}/package.json`) as { version: string }).version;
}

const DIRECT = ['deepagents', 'langchain', '@langchain/core', '@langchain/anthropic', '@langchain/openai'];
const PEERS = ['@langchain/langgraph', '@langchain/langgraph-checkpoint', '@langchain/langgraph-sdk', 'langsmith'];

/** The packages whose installed version differs from the record, each named with both versions. */
function recordMismatches(recorded: Readonly<Record<string, string>>, installed: Readonly<Record<string, string>>): string[] {
  return Object.keys(installed)
    .filter((name) => recorded[name] !== installed[name])
    .map((name) => `${name}: recorded ${recorded[name] ?? 'nothing'}, installed ${installed[name] ?? 'nothing'}; run the guard's update mode so that the allowlist suite is run against the new version`);
}

describe('the record of the versions the allowlist suite was run against', () => {
  it('names the package and both versions of a hand-edited record that does not match what is installed', () => {
    expect(recordMismatches({ deepagents: '1.2.3' }, { deepagents: '1.17.0' })).toEqual(["deepagents: recorded 1.2.3, installed 1.17.0; run the guard's update mode so that the allowlist suite is run against the new version"]);
    expect(recordMismatches({}, { langsmith: '0.13.1' })[0]).toContain('recorded nothing');
  });

  it('matches the installed versions of the guarded packages and of the peers deepagents resolves through', () => {
    const record = (JSON.parse(readFileSync(recordPath, 'utf8')) as { versions: Record<string, string> }).versions;
    const installed = Object.fromEntries([...DIRECT.map((name) => [name, installedVersion(name, true)]), ...PEERS.map((name) => [name, installedVersion(name, false)])]);
    expect(recordMismatches(record, installed)).toEqual([]);
  });
});

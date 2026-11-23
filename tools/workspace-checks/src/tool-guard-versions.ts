/** The packages whose versions the allowlist suite of the offered tools is run against: the direct dependencies of `ee/assistant-agent` and the peers deepagents resolves through, which no package file names. */
const DIRECT_GUARDED = ['deepagents', 'langchain', '@langchain/core', '@langchain/anthropic', '@langchain/openai'] as const;
const PEER_GUARDED = ['@langchain/langgraph', '@langchain/langgraph-checkpoint', '@langchain/langgraph-sdk', 'langsmith'] as const;
export const ALL_GUARDED: readonly string[] = [...DIRECT_GUARDED, ...PEER_GUARDED];

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The direct dependencies of the package file that are not an exact version, each named with what the file says. */
export function pinProblems(packageJsonText: string): string[] {
  const parsed = JSON.parse(packageJsonText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = { ...parsed.devDependencies, ...parsed.dependencies };
  return DIRECT_GUARDED.flatMap((name) => {
    const range = dependencies[name];
    if (range === undefined) return [`${name} is not a dependency of ee/assistant-agent`];
    return EXACT.test(range) ? [] : [`${name} is "${range}" in ee/assistant-agent/package.json: pin an exact version`];
  });
}

const LOCK_ENTRY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@(\d[^'(:\s]*)'?:$/;

/** The resolved versions of each package in the `packages:` block of the lockfile (a package can resolve to several). */
export function lockVersions(lockText: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let inPackages = false;
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) inPackages = line.startsWith('packages:');
    if (!inPackages) continue;
    const match = LOCK_ENTRY.exec(line);
    const name = match?.[1];
    const version = match?.[2];
    if (name === undefined || version === undefined) continue;
    found.set(name, [...(found.get(name) ?? []), version]);
  }
  return found;
}

/** The guarded packages whose resolved version in the lockfile is not the one recorded: each named with the recorded and the resolved version and the way out. */
export function recordProblems(recorded: Readonly<Record<string, string>>, lockText: string): string[] {
  const locked = lockVersions(lockText);
  return ALL_GUARDED.flatMap((name) => {
    const resolved = locked.get(name) ?? [];
    if (resolved.length !== 1) return [`${name} resolves to ${resolved.length === 0 ? 'no version' : resolved.join(' and ')} in pnpm-lock.yaml: it must resolve to exactly one version; run the guard's update mode once it does`];
    const [version] = resolved;
    return recorded[name] === version ? [] : [`${name}: recorded ${recorded[name] ?? 'nothing'}, resolved ${version ?? 'nothing'} in pnpm-lock.yaml; run the guarded suites and the update mode (NBX_UPDATE_TOOL_GUARD=1 pnpm --filter @neburyx/workspace-checks exec vitest run src/tool-guard-versions.test.ts)`];
  });
}

/** The record as written: the versions the lockfile resolves, in the order of the guarded packages. */
function recordText(lockText: string): string {
  const locked = lockVersions(lockText);
  const versions = Object.fromEntries(ALL_GUARDED.map((name) => [name, locked.get(name)?.[0] ?? '']));
  return `${JSON.stringify({ note: 'The versions of the packages the allowlist suite of the offered tools was last run against. Written only by the update mode of that check (tools/workspace-checks), after the guarded suites passed; never edit it by hand.', versions }, null, 2)}\n`;
}

/** The update mode: the record is written from the lockfile only when every guarded package resolves to exactly one version and the guarded suites passed in this run; otherwise it is left unchanged and the reason is returned. */
export function updateRecord(run: { readonly suitesPassed: () => boolean; readonly lockText: string; readonly write: (text: string) => void }): { readonly written: boolean; readonly problems: readonly string[] } {
  const locked = lockVersions(run.lockText);
  const unresolved = ALL_GUARDED.filter((name) => (locked.get(name) ?? []).length !== 1).map((name) => `${name} resolves to ${(locked.get(name) ?? []).join(' and ') || 'no version'} in pnpm-lock.yaml: it must resolve to exactly one version`);
  if (unresolved.length > 0) return { written: false, problems: unresolved };
  if (!run.suitesPassed()) return { written: false, problems: ['a guarded suite failed: the record is left unchanged'] };
  run.write(recordText(run.lockText));
  return { written: true, problems: [] };
}

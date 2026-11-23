export { AIMessage } from '@langchain/core/messages';
export { fakeModel } from '@langchain/core/testing';

/** Tools deepagents 1.17.0 always assembles (a fact about the framework, kept once) and its exclusion removes before a model sees them. Nothing else outside the allowlist may be assembled. */
export const KNOWN_REMOVED_FRAMEWORK_TOOLS: readonly string[] = ['read_file', 'task'];

/** What the guard of the offered tools compares: the lists of each model request at its two capture points, and the names that are allowed. */
export interface ToolListCheck {
  /** Every tool the Assistant may offer, by name: the whole allowlist, written out. */
  readonly allowed: readonly string[];
  /** Framework tools that deepagents always assembles and its exclusion removes before the model sees them; nothing else outside `allowed` may be assembled. */
  readonly knownRemoved: readonly string[];
  /** The names deepagents assembled for each request, before its exclusion and before the product's filter (`AgentRun.assembled`). */
  readonly assembled: readonly (readonly string[])[];
  /** The names the model was bound to for each request. */
  readonly sent: readonly (readonly string[])[];
  /** The first request must offer every allowed tool, with none missing. */
  readonly requireAllOnFirst: boolean;
  /** When set, the last request is the last call the turn allows and must be sent this tool alone. */
  readonly lastCallOnly?: string;
}

/**
 * The failures of the lists of the tools of a turn, each naming the tool and saying what is wrong: a tool sent that is not allowed, a tool assembled that is neither allowed nor a known framework tool that is removed,
 * (on the first request) an allowed tool that is missing from what was sent, and (on the last call) a tool sent besides the final one. The messages hold tool names only.
 */
export function toolListFailures(check: ToolListCheck): string[] {
  const allowed = new Set(check.allowed);
  const known = new Set(check.knownRemoved);
  const failures: string[] = [];
  check.assembled.forEach((names, index) => {
    for (const name of names) if (!allowed.has(name) && !known.has(name)) failures.push(`request ${index + 1}: the framework assembled "${name}", which is extra: neither allowed nor a known framework tool that is removed`);
  });
  check.sent.forEach((names, index) => {
    for (const name of names) if (!allowed.has(name)) failures.push(`request ${index + 1}: the model was sent "${name}", which is extra: it is not on the allowlist`);
    if (index === 0 && check.requireAllOnFirst) for (const name of check.allowed) if (!names.includes(name)) failures.push(`request 1: the model was not sent "${name}", which is missing from the allowlist's tools`);
    if (check.lastCallOnly !== undefined && index === check.sent.length - 1) for (const name of names) if (name !== check.lastCallOnly && allowed.has(name)) failures.push(`request ${index + 1} (the last call): the model was sent "${name}" besides "${check.lastCallOnly}", which is more than the final tool`);
  });
  return failures;
}

/** The packages whose installed version differs from the recorded one, each named with both versions and the way out. */
export function recordMismatches(recorded: Readonly<Record<string, string>>, installed: Readonly<Record<string, string>>): string[] {
  return Object.keys(installed)
    .filter((name) => recorded[name] !== installed[name])
    .map((name) => `${name}: recorded ${recorded[name] ?? 'nothing'}, installed ${installed[name] ?? 'nothing'}; run the guard's update mode so that the allowlist suite is run against the new version`);
}

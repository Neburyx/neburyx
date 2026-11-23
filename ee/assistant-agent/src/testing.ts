export { AIMessage } from '@langchain/core/messages';
export { fakeModel } from '@langchain/core/testing';

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
}

/**
 * The failures of the lists of the tools of a turn, each naming the tool and saying what is wrong: a tool sent that is not allowed, a tool assembled that is neither allowed nor a known framework tool that is removed, and
 * (on the first request) an allowed tool that is missing from what was sent. The messages hold tool names only.
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
  });
  return failures;
}

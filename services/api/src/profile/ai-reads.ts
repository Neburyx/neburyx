import type { AskRunner, AskRunScope, ElementRefs, ElementsScope, ExtensionRequest, SummaryReading } from '@neburyx/contracts';
import { asAiReads } from '../seams/read-origin.js';

/** The reads an AI feature makes are the ones it makes through these two capabilities, so the core marks them here and the AI code has no way to leave the mark off. */
export function markAskRunner(runnerFor: (scope: AskRunScope) => AskRunner): (scope: AskRunScope) => AskRunner {
  return (scope) => {
    const runner = runnerFor(scope);
    return { run: (asked, options) => asAiReads(() => runner.run(asked, options)) };
  };
}

export function markReadElements<Scope>(read: (scope: Scope, refs: ElementRefs) => Promise<SummaryReading>): (scope: Scope, refs: ElementRefs) => Promise<SummaryReading> {
  return (scope, refs) => asAiReads(() => read(scope, refs));
}

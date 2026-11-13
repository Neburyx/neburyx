import { describe, expect, it } from 'vitest';
import { makeRoot } from '../domain-words/fixtures.js';
import { repoRoot } from '../workspace.js';
import { PATTERN_DEFINITION_FILE, checkPatternDefinition, formatPatternViolations } from './check.js';

const DEFINES = "import { z } from 'zod';\nexport const step = z.strictObject({ relationshipTypes: z.array(z.string()), arrivesAt: z.string() });\n";
const USES = "import { patternDefinitionSchema } from '@neburyx/contracts';\nexport const read = (step: { arrivesAt: string }) => step.arrivesAt;\n";

describe('the pattern definition in this repository', () => {
  it('is defined once, in the contracts, and nowhere else', () => {
    expect(checkPatternDefinition(repoRoot)).toEqual([]);
  });
});

describe('the check', () => {
  it('passes for the one file that defines it, and for files that import it and read a step', () => {
    expect(checkPatternDefinition(makeRoot({ [PATTERN_DEFINITION_FILE]: DEFINES, 'services/api/src/validate.ts': USES, 'apps/web/src/builder.tsx': USES }))).toEqual([]);
  });

  it('fails for a file in the web app or the API that builds a step as an object schema, naming it', () => {
    const violations = checkPatternDefinition(makeRoot({ [PATTERN_DEFINITION_FILE]: DEFINES, 'apps/web/src/copy.ts': DEFINES, 'services/api/src/copy.ts': DEFINES.replace('strictObject', 'object') }));
    expect(violations.map((violation) => violation.file).sort()).toEqual(['apps/web/src/copy.ts', 'services/api/src/copy.ts']);
    expect(formatPatternViolations(violations)).toContain('apps/web/src/copy.ts defines a pattern schema of its own');
  });

  it('does not read a test file, and does not read a file with an object schema that has no step in it', () => {
    expect(checkPatternDefinition(makeRoot({ 'services/api/src/a.test.ts': DEFINES, 'services/api/src/b.ts': "import { z } from 'zod';\nexport const x = z.strictObject({ name: z.string() });\n" }))).toEqual([]);
  });
});

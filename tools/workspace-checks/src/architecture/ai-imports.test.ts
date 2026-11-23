import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { AI_IMPORT_SCAN_ROOTS, checkAiImports } from './ai-imports.js';
import { loadTree } from './tree.js';
import { formatViolations } from './violations.js';

const fixtures = join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'architecture');
const fixture = (name: string) => checkAiImports(loadTree(join(fixtures, name), { include: AI_IMPORT_SCAN_ROOTS }));

describe('the imports of the AI packages', () => {
  it('reports an import of the Neo4j driver in the runtime package, with the file, the line and the import', () => {
    expect(fixture('ai-runtime-imports-driver')).toMatchObject([{ rule: 'ai-imports', file: 'ee/ai-runtime/src/reader.ts', line: 1, specifier: 'neo4j-driver' }]);
  });

  it('reports an import of a path into services/api in the Ask package', () => {
    expect(fixture('ai-ask-imports-api')).toMatchObject([{ rule: 'ai-imports', file: 'ee/ask/src/reader.ts', line: 1, specifier: '../../../services/api/src/gate/gate.js' }]);
  });

  it('accepts own files, Node built-ins and the allowed packages, and skips a test file', () => {
    expect(fixture('ai-clean')).toEqual([]);
  });

  it('refuses pg in the runtime package, which the Ask package may import for its run stores', () => {
    const runtime = checkAiImports([{ path: 'ee/ai-runtime/src/a.ts', text: "import pg from 'pg';" }]);
    const ask = checkAiImports([{ path: 'ee/ask/src/a.ts', text: "import pg from 'pg';" }]);
    expect(runtime.map((violation) => violation.specifier)).toEqual(['pg']);
    expect(ask).toEqual([]);
  });

  it('allows deepagents and the LangChain packages in the assistant agent package only', () => {
    const imports = "import { createDeepAgent } from 'deepagents';\nimport { tool } from 'langchain';\nimport { ChatAnthropic } from '@langchain/anthropic';";
    expect(checkAiImports([{ path: 'ee/assistant-agent/src/a.ts', text: imports }])).toEqual([]);
    for (const owner of ['ee/ask/src/a.ts', 'ee/ai-runtime/src/a.ts']) {
      expect(checkAiImports([{ path: owner, text: imports }]).map((violation) => violation.specifier)).toEqual(['deepagents', 'langchain', '@langchain/anthropic']);
    }
  });

  it('lets the Ask package import the assistant agent package and refuses it anywhere else', () => {
    const text = "import { runAgent } from '@neburyx/ee-assistant-agent';";
    expect(checkAiImports([{ path: 'ee/ask/src/a.ts', text }])).toEqual([]);
    expect(checkAiImports([{ path: 'ee/ai-runtime/src/a.ts', text }]).map((violation) => violation.specifier)).toEqual(['@neburyx/ee-assistant-agent']);
  });

  it('passes on the real tree', () => {
    const real = loadTree(repoRoot, { include: AI_IMPORT_SCAN_ROOTS });
    expect(real.map((file) => file.path)).toContain('ee/ai-runtime/src/index.ts');
    expect(formatViolations(checkAiImports(real))).toBe('');
  }, 30_000);
});

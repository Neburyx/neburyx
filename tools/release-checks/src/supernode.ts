import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandCheck, describeCommand, execFailure } from './command-check.js';
import { neo4jConnection } from './connection.js';
import { testsPassed } from './test-output.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest } from './types.js';

export function supernodeSuiteCheck(settingsFile?: string): Check {
  const request: ExecRequest = { command: 'pnpm', args: ['test:supernodes'] };
  const command = describeCommand(request);
  return {
    id: 'supernode-suite',
    name: 'Supernode suite (1k, 10k, 100k)',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const connection = neo4jConnection(context.env, settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command, exitCode: null, output: `${connection.detail}\n` };
      const recordFile = join(context.workDir, 'supernode-suite-record.json');
      const result = await context.exec({ ...request, cwd: context.repoRoot, env: { NBX_SUPERNODE_RECORD: recordFile } });
      const base = { command, exitCode: result.exitCode, output: result.output, data: { recordFile } };
      const failure = execFailure(result, undefined);
      if (failure !== undefined) return { ...base, status: 'failed', detail: failure };
      const passed = testsPassed(result.output);
      if (passed === undefined || passed < 1) return { ...base, status: 'failed', detail: 'no tests ran' };
      if (!existsSync(recordFile)) return { ...base, status: 'failed', detail: 'no suite record written' };
      return { ...base, status: 'passed', detail: `${passed} tests passed; record ${recordFile}` };
    },
  };
}

export function fuzzRealServerCheck(repoRoot: string, settingsFile?: string): Check {
  const inner = commandCheck({
    id: 'fuzz-real-server',
    name: 'Input fuzz on a real Neo4j test database',
    requests: [{ command: 'pnpm', args: ['--filter', '@neburyx/api', 'exec', 'vitest', 'run', '--config', 'vitest.neo4j.config.ts', 'src/fuzz/real-server.neo4j.test.ts'], cwd: repoRoot }],
    expectsTests: true,
  });
  return {
    ...inner,
    run: async (context) => {
      const connection = neo4jConnection(context.env, settingsFile);
      if (!connection.ok) return { status: 'failed', detail: connection.detail, command: inner.command, exitCode: null, output: `${connection.detail}\n` };
      return inner.run(context);
    },
  };
}

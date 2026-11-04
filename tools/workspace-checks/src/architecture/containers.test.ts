import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkContainerStarts, CONTAINER_SCAN_ROOTS } from './containers.js';
import { loadTree } from './tree.js';
import { formatViolations } from './violations.js';

const check = (text: string, path = 'services/api/src/testing/a.ts') => checkContainerStarts([{ path, text }]);

describe('a container started without the retry helper', () => {
  it.each([
    "const started = await new PostgreSqlContainer('postgres:16').start();",
    "const started = await new Neo4jContainer(image).withPassword(p).withStartupTimeout(1).start();",
    "const started = await new GenericContainer('x').withExposedPorts(80).start();",
    "const container = new Neo4jContainer(image).withPassword(p);\nconst started = await container.start();",
    "export {};\nconst started = await (new Neo4jContainer(image) as Neo4jContainer).start();",
    "let c;\nc = new Neo4jContainer(i);\nawait c.start();",
    "const container = new Neo4jContainer(i);\nfunction run() {\n  return container.start();\n}",
    "let c = new Neo4jContainer(i);\nfunction unused() {\n  c = new Poller();\n}\nawait c.start();",
    "let c;\nfunction run() {\n  c = new Neo4jContainer(i);\n  return c.start();\n}",
    "var c;\nif (ready) {\n  c = new GenericContainer('x');\n}\nawait c.start();",
  ])('is reported: %s', (text) => {
    expect(check(text)).toMatchObject([{ rule: 'container-start', file: 'services/api/src/testing/a.ts' }]);
  });

  it('is reported in a test file and in a tool as well, with its line', () => {
    expect(check("\n\nawait new PostgreSqlContainer('x').start();", 'tools/driver-check/src/server.test.ts')).toMatchObject([{ line: 3, file: 'tools/driver-check/src/server.test.ts' }]);
  });

  it('is reported when a start that is not inside the helper follows one that is', () => {
    const text = "await startWithRetry((labels) => new Neo4jContainer(i).withLabels(labels).start());\nawait new Neo4jContainer(i).start();";
    expect(check(text)).toMatchObject([{ line: 2 }]);
  });
});

describe('a container started through the retry helper', () => {
  it.each([
    "const started = await startWithRetry((labels) => new PostgreSqlContainer('postgres:16').withLabels(labels).start());",
    "const started = await startWithRetry((labels) => {\n  const container = new Neo4jContainer(i).withLabels(labels);\n  return container.start();\n});",
    "const started = await startWithRetry(async (labels) => await new Neo4jContainer(i).withLabels(labels).start(), { attempts: 1 });",
  ])('is not reported: %s', (text) => {
    expect(check(text)).toEqual([]);
  });

  it.each([
    'poller.start();',
    'server.start();',
    "const timer = new Timer().start();",
    "const container = new Map();\ncontainer.start();",
    'await stack.up();',
    "const container = new Neo4jContainer(i);\nfunction run(container: Poller) {\n  container.start();\n}",
    "const container = new Neo4jContainer(i);\n{\n  const container = new Poller();\n  container.start();\n}",
    "let c = new Neo4jContainer(i);\nc = new Poller();\nc.start();",
    "let c = new Neo4jContainer(i);\nfunction run() {\n  c = new Poller();\n  return c.start();\n}",
    "let c = new Poller();\nfunction unused() {\n  c = new Neo4jContainer(i);\n}\nc.start();",
    "const run = ({ container }: { container: Poller }) => container.start();\nconst container = new Neo4jContainer(i);",
  ])('is not reported for something that is not a container: %s', (text) => {
    expect(check(text)).toEqual([]);
  });
});

describe('the repository', () => {
  it('starts every test container through the retry helper', () => {
    const files = loadTree(repoRoot, { include: CONTAINER_SCAN_ROOTS });
    expect(files.length).toBeGreaterThan(100);
    expect(formatViolations(checkContainerStarts(files))).toBe('');
  });
});

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READINESS_LIMIT_MS } from '../health/readiness.js';
import { parseMapping } from './load.js';
import { RETENTION_DEFAULTS } from './retention.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const guide = read('docs/install.md');
const compose = read('deploy/compose/compose.yaml');
const example = read('deploy/compose/.env.example');
const composeReadme = read('deploy/compose/README.md');

function blocks(language: string): string[] {
  return [...guide.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1] ?? '');
}

function section(heading: string): string {
  const start = guide.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const next = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, next === -1 ? undefined : next);
}

describe('the install guide', () => {
  it('names only settings that the compose file or the settings example holds', () => {
    const names = new Set([...guide.matchAll(/\bNEBURYX_[A-Z0-9_]+\b/g)].map((match) => match[0]).filter((name) => !name.startsWith('NEBURYX_RELEASE_PLACEHOLDER_')));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) expect(compose.includes(name) || example.includes(name), name).toBe(true);
  });

  it('loads the mapping it shows, and the variables of its source.env example are the ones that mapping names', () => {
    const mappings = blocks('yaml').filter((block) => block.startsWith('sources:'));
    expect(mappings).toHaveLength(1);
    const mapping = parseMapping(mappings[0] ?? '', 'install.md');
    const source = mapping.sources[0];
    expect(source).toBeDefined();
    const shown = blocks('bash').find((block) => block.includes('source.env')) ?? '';
    const variables = [...shown.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(variables).toEqual([source?.auth.usernameEnv, source?.auth.passwordEnv]);
  });

  it('shows a retention block that loads, with the defaults and range of the schema', () => {
    const block = blocks('yaml').find((text) => text.startsWith('retention:')) ?? '';
    const loaded = parseMapping(`sources: []\n${block}`, 'install.md');
    expect(loaded.retention).toEqual(RETENTION_DEFAULTS);
    const text = section('Retention');
    expect(text).toContain(`${RETENTION_DEFAULTS.deletedInvestigationsDays} and ${RETENTION_DEFAULTS.exportsDays} days`);
    expect(text).toContain('1 to 365');
  });

  it('states the readiness limit that the probe uses', () => {
    expect(section('Connect your Neo4j')).toContain(`${READINESS_LIMIT_MS / 1000} seconds`);
  });

  it('uses the product\'s own words for the read-only result and the exit codes of test-source', () => {
    const command = readFileSync(join(ROOT, 'services/api/src/source-test/command.ts'), 'utf8');
    for (const words of ['privileges inspected', 'not verified', 'write probe']) {
      expect(command, words).toContain(`'${words}'`);
      expect(guide, words).toContain(`Read-only: ${words}`);
    }
    expect(guide).toContain('Read-only: not verified');
    expect(guide).toMatch(/exit code is `0` for pass and warn, `1` for fail.*`2` for a usage error/);
    expect(guide).toMatch(/\| `0` \|[\s\S]*\| `1` \|[\s\S]*\| `2` \|/);
  });

  it('says the install is loopback only and shows how to confirm it, as the compose file publishes it', () => {
    expect(compose).toContain('"127.0.0.1:${NEBURYX_PORT:-8080}:8080"');
    const text = section('Loopback only');
    expect(text).toContain('docker compose port api 8080');
    expect(text).toContain('127.0.0.1:8080');
    expect(text).toContain('no sign-in');
  });

  it('says what a roll back refuses, and that it applies nothing then', () => {
    const text = section('Roll back by one tag');
    expect(text).toContain('refused');
    expect(text).toContain('names the file and applies nothing');
  });

  it('names the Compose version the optional settings file needs, in the guide and the compose README', () => {
    expect(guide).toContain('Docker Compose 2.24 or later');
    expect(composeReadme).toContain('2.24');
  });

  it('is linked from the docs index and the compose README', () => {
    expect(read('docs/README.md')).toContain('(install.md)');
    expect(composeReadme).toContain('docs/install.md');
  });

  it('holds no planning label and no address or login that could be real', () => {
    expect(guide).not.toMatch(/\b(EP|OD|DM|Q|F|B|G)-?\d+(\.\d+)*\b/);
    const addresses = [...guide.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)].map((match) => match[0]);
    expect(addresses.filter((address) => address !== '127.0.0.1' && address !== '0.0.0.0')).toEqual([]);
  });
});

const WRITE_ENV_FILES = ['docs/install.md', 'deploy/compose/README.md', 'deploy/demo/README.md'] as const;

function dedent(block: string): string {
  const lines = block.split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join('\n');
}

function writeEnvCommand(file: string): string {
  const blocks = [...read(file).matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => dedent(match[1] ?? '')).filter((block) => block.includes('cat > .env'));
  expect(blocks, file).toHaveLength(1);
  return blocks[0] ?? '';
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').filter((line) => /^[A-Z0-9_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function requiredBy(composePath: string): string[] {
  return [...new Set([...read(composePath).matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1] ?? ''))];
}

describe('the one command that writes .env', () => {
  it.each(WRITE_ENV_FILES)('in %s writes every required setting with a value that follows its rule, mode 0600, and never overwrites', (file) => {
    const command = writeEnvCommand(file);
    const folder = mkdtempSync(join(tmpdir(), 'write-env-'));
    try {
      const first = spawnSync('bash', ['-c', command], { cwd: folder, encoding: 'utf8' });
      expect(first.status, first.stderr).toBe(0);
      const written = readFileSync(join(folder, '.env'), 'utf8');
      expect(statSync(join(folder, '.env')).mode & 0o777).toBe(0o600);
      const values = parseEnv(written);
      const required = requiredBy(file.startsWith('deploy/demo') ? 'deploy/demo/compose.yaml' : 'deploy/compose/compose.yaml');
      for (const name of required) expect(values, name).toHaveProperty(name);
      for (const name of ['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD']) expect(values[name], name).toMatch(/^[A-Za-z0-9]{48}$/);
      const key = Buffer.from(values['NEBURYX_CURSOR_KEY'] ?? '', 'base64');
      expect(key.length).toBeGreaterThanOrEqual(32);
      expect(key.toString('base64')).toBe(values['NEBURYX_CURSOR_KEY']);
      if (file.startsWith('deploy/demo')) expect(values['DEMO_NEO4J_PASSWORD']?.length ?? 0).toBeGreaterThanOrEqual(8);
      else expect(values['NEBURYX_TAG']).toBe('local');

      mkdirSync(join(folder, 'other'));
      const before = spawnSync('bash', ['-c', 'umask'], { encoding: 'utf8' }).stdout;
      const after = spawnSync('bash', ['-c', `${command}\numask`], { cwd: join(folder, 'other'), encoding: 'utf8' });
      expect(after.stdout.trim().split('\n').at(-1)).toBe(before.trim());

      const second = spawnSync('bash', ['-c', command], { cwd: folder, encoding: 'utf8' });
      expect(second.stdout).toContain('.env exists');
      expect(readFileSync(join(folder, '.env'), 'utf8')).toBe(written);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('writes the tag that the guide\'s build command makes', () => {
    const tag = /-t neburyx:([A-Za-z0-9._-]+)/.exec(guide)?.[1];
    expect(tag).toBeDefined();
    expect(writeEnvCommand('docs/install.md')).toContain(`NEBURYX_TAG=${tag}`);
    expect(writeEnvCommand('deploy/compose/README.md')).toContain(`NEBURYX_TAG=${tag}`);
  });

  it.each(WRITE_ENV_FILES)('is explained in %s: never overwrites, a changed password later is not its job, never commit, where the failed check\'s message is', (file) => {
    const text = read(file);
    for (const phrase of ['refuses to touch a `.env` that already exists', 'Changing a password after the first start is not done by this command', 'Never commit `.env`', 'docker compose logs']) expect(text, `${file}: ${phrase}`).toContain(phrase);
  });
});

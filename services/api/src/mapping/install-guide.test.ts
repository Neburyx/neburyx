import { readFileSync } from 'node:fs';
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
